<#
.SYNOPSIS
  Windows port of claude-session-mirror's bin/mirror-start.sh.

.DESCRIPTION
  A port of Cairn-2001's launcher. The SERVER needed two fixes (both now upstream
  in 304fd51); this launcher is the actual port, because bin/mirror-start.sh is
  325 lines of bash.

  Verified on lupos-lap, Windows 11, node v24.11.1, Claude Code 2.1.251:
    - os.homedir() resolves correctly; dataDir lands in C:\Users\<u>\.claude-mirror
    - .hacs-identity parses through a UTF-8 BOM (utf-8-sig)
    - every src/*.mjs parses under node v24
    - the slug algorithm is already platform-correct (see below)
    - CLAUDE_CODE_SESSION_ID *is* exported to children on Windows

  NOT RUN. Written, not started -- standing up a server is persistent machine
  state and Lupo was away. Someone must review before this first launches.

.NOTES
  DEFAULTS TO READ-ONLY WITH NO GRANTS, per Cairn's instruction: confirm the
  transcript tail and SSE stream work on Windows before any write path exists.
  If the read half is broken you want to know that without a browser also being
  able to type into your session.

  Author: Lodestone <lodestone@smoothcurves.nexus>
  Ported from: bin/mirror-start.sh by Cairn-2001
  Collaborator: Lupo
#>

[CmdletBinding()]
param(
    [string] $IdentityFile = $(if ($env:HACS_IDENTITY_FILE) { $env:HACS_IDENTITY_FILE } else { Join-Path $env:USERPROFILE ".hacs-identity" }),
    [string] $MirrorHome   = "",
    [int]    $Port         = 0,
    # Bind. NEVER 0.0.0.0 -- see MIRROR-CONTRACT.md section 12.
    [string] $Bind         = "",
    [switch] $PermissionsOnly,
    # Every write capability is granted ONLY by being asked for. Never by flag
    # ordering, never inherited from the environment. All default OFF, including
    # interrupt -- which now MATCHES the bash launcher (upstream 8309cce), see below.
    [switch] $WithInput,
    [switch] $WithInterrupt,
    [switch] $WithCommands,
    [switch] $WithUploads,
    [switch] $WhatIf
)

$ErrorActionPreference = "Stop"
function Die($m) { Write-Error "mirror-start: $m"; exit 1 }

# $PSScriptRoot is already this script's DIRECTORY (bin/), so ONE Split-Path reaches
# the repo root. The bash original is dirname(FILE)/.. -- also one level. Two
# Split-Paths landed one directory ABOVE the repo; measured 2026-10-07 by
# Lantern-4224: "server not found at D:\Lupo\Source\AI\src\mirror-server.mjs".
if (-not $MirrorHome) { $MirrorHome = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path $IdentityFile)) { Die "no identity file at $IdentityFile" }

# ---- identity ---------------------------------------------------------------
# utf-8-sig, not utf-8. PowerShell 5.1's `-Encoding utf8` writes a UTF-8 BOM, and
# a BOM makes json parsing fail with "Expecting value: line 1 column 1" -- an
# error that reads like a corrupt file and sends you looking in the wrong place.
$identityRaw = [IO.File]::ReadAllText($IdentityFile, (New-Object Text.UTF8Encoding $false))
$identityRaw = $identityRaw.TrimStart([char]0xFEFF)
try { $identity = $identityRaw | ConvertFrom-Json } catch { Die "cannot parse $IdentityFile : $_" }

$instance    = $identity.instanceId
$channelPort = $identity.channelPort
if (-not $instance) { Die "no instanceId in $IdentityFile" }

$instanceDir = (Resolve-Path (Split-Path -Parent $IdentityFile)).Path

# ---- find the live transcript ----------------------------------------------
# Skipped entirely in permissions mode. Not located, not opened, not handed to
# the server -- the privacy guarantee is visible here, not only in the code that
# would have read it.
$transcript = ""
$sidSource  = ""
if (-not $PermissionsOnly) {

    # The slug is the cwd with every non-alphanumeric replaced by '-'. This is
    # ALREADY platform-correct: on Windows both "D:\a\b" and "D:/a/b" collapse to
    # "D--a-b", which is exactly the slug Claude Code itself writes. Verified
    # against a real project dir. No change needed -- do not "fix" it.
    $slug = ($instanceDir -replace '[^a-zA-Z0-9]', '-')

    # PORTABILITY FINDING (not Windows-specific): the bash launcher looks in
    # "$INSTANCE_DIR/.claude/projects/$SLUG", which holds for a CHASSIS instance
    # where the instance dir is the session cwd. It does NOT hold for an instance
    # whose transcripts live under the user profile -- the ordinary layout for a
    # developer box. So try the chassis location first, then the user profile.
    $candidates = @(
        (Join-Path $instanceDir ".claude\projects\$slug"),
        (Join-Path $env:USERPROFILE ".claude\projects\$slug")
    )

    # A DIRECTORY EXISTING IS NOT EVIDENCE ABOUT WHICH MIND LIVES IN IT.
    # Cairn's amendment (upstream 7c83d67), adopted here because it is stronger
    # than the first-existing-wins version I originally wrote:
    #   with a session id  -> pick the candidate CONTAINING <sid>.jsonl. Absent
    #                         from all of them is an ERROR naming every path
    #                         tried, never a reason to fall back.
    #   without one        -> we are already about to guess by mtime, so refuse
    #                         to guess TWICE: exactly one candidate may exist.
    # That second branch is the one that matters: no sid + two directories + an
    # mtime heuristic is how you mirror the wrong mind.
    $sid = $env:CLAUDE_CODE_SESSION_ID
    if (-not $sid) {
        $rec = Join-Path $instanceDir ".claude-session-id"
        if (Test-Path $rec) { $sid = ([IO.File]::ReadAllText($rec)).Trim() }
    }

    $proj = $null
    if ($sid) {
        $proj = $candidates | Where-Object { Test-Path (Join-Path $_ "$sid.jsonl") } | Select-Object -First 1
        if (-not $proj) {
            $candidates | ForEach-Object { Write-Host "  $(Join-Path $_ "$sid.jsonl")" }
            Die "session id $sid names no transcript in any known layout. Refusing to guess -- a named session with no transcript is an error, never a reason to fall back."
        }
    } else {
        $present = @($candidates | Where-Object { Test-Path $_ })
        if ($present.Count -gt 1) {
            $present | ForEach-Object { Write-Host "  $_" }
            Die "two project directories exist and no session id is known. Refusing to guess twice -- set CLAUDE_CODE_SESSION_ID or record one."
        }
        if ($present.Count -eq 0) {
            $candidates | ForEach-Object { Write-Host "  $_" }
            Die "no project dir found"
        }
        $proj = $present[0]
    }

    # ---- which transcript? A TRUST LADDER, not a guess ----------------------
    # 1. CLAUDE_CODE_SESSION_ID from our own environment. Authoritative: the
    #    session's own name for itself, and it survives --resume. VERIFIED to be
    #    exported to child processes on Windows, so this rung works here.
    if ($sid) {
        $c = Join-Path $proj "$sid.jsonl"
        if (Test-Path $c) {
            $transcript = $c
            $sidSource = if ($env:CLAUDE_CODE_SESSION_ID) { "session environment (authoritative)" } else { "recorded id" }
        }
    }
    # (Rung 2 -- a recorded id for boot-time starts -- is resolved ABOVE, together
    # with the candidate directory, because the two questions are the same
    # question: an id you cannot place is not an id you can use.)
    # 3. Newest transcript. A GUESS, and labelled as one. Resuming or mirroring
    #    the wrong session does not fail loudly -- an 18-month-old transcript
    #    resumes clean, so "it worked" never implies "it was the right mind."
    if (-not $transcript) {
        $newest = Get-ChildItem -Path $proj -Filter *.jsonl -File -ErrorAction SilentlyContinue |
                  Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($newest) { $transcript = $newest.FullName; $sidSource = "NEWEST FILE (guess)" }
    }
    if (-not $transcript) { Die "no transcript found under $proj" }

    # Record rung 1 for later boot-time starts.
    if ($env:CLAUDE_CODE_SESSION_ID -and -not $WhatIf) {
        [IO.File]::WriteAllText((Join-Path $instanceDir ".claude-session-id"), $env:CLAUDE_CODE_SESSION_ID)
    }
}

# ---- bind -------------------------------------------------------------------
# tailscale IS present on this box, so the bash launcher's detection works. The
# fallback is loopback, never 0.0.0.0. Law 12.1: loopback is not a security
# boundary either -- every local process can reach it.
if (-not $Bind) {
    $Bind = "127.0.0.1"
    $ts = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($ts) {
        $ip = (& $ts.Source ip -4 2>$null | Select-Object -First 1)
        if ($ip -and $ip -match '^\d+\.\d+\.\d+\.\d+$') { $Bind = $ip.Trim() }
    }
}
if ($Bind -eq "0.0.0.0") { Die "refusing to bind 0.0.0.0 -- see MIRROR-CONTRACT.md section 12" }

# ---- grants -----------------------------------------------------------------
$allowSend      = [int][bool]$WithInput
$allowInterrupt = [int][bool]$WithInterrupt
$allowCommands  = [int][bool]$WithCommands
$allowUpload    = if ($PSBoundParameters.ContainsKey('WithUploads')) { [int][bool]$WithUploads } else { $allowSend }

# PARITY, not divergence. This comment once called itself a DELIBERATE DIVERGENCE:
# the bash launcher defaulted interrupt ON in full mode ("there is a tmux session
# to interrupt"). Lodestone diverged loudly instead of inheriting it, because there
# is no tmux here -- and the premise was worse than that: MIRROR_TMUX_SESSION falls
# back to the instance id, so it was a NAME, never a verified session.
# Upstream then converged: commit 8309cce (2026-08-30) made interrupt OFF by
# default in every mode, matching this port. So this is now parity, and saying so
# matters -- a stale "divergence" comment invites the next porter to preserve a
# difference that no longer exists. Interrupt stays OFF unless asked for.
# Corrected by Lantern-4224 on Cairn-2001's review, 2026-10-08.

$env:MIRROR_BIND      = $Bind
# Parity with bin/mirror-start.sh:317-318. The Windows port omitted these, so the
# server reported instance="unknown" and labelled the mind "Instance" -- a mind
# shown to its human without its name. ${INSTANCE%%-*} strips from the FIRST
# hyphen: Lantern-4224 -> Lantern. Found by Lantern-4224, 2026-10-07.
$env:MIRROR_INSTANCE = $instance
if (-not $env:MIRROR_DISPLAY) { $env:MIRROR_DISPLAY = ($instance -split '-', 2)[0] }
$env:MIRROR_BASE_PATH = if ($env:MIRROR_BASE_PATH) { $env:MIRROR_BASE_PATH } else { "/" + ($instance -split '-')[0] }
$env:MIRROR_ROOM      = if ($env:MIRROR_ROOM) { $env:MIRROR_ROOM } else { $instance }
if ($Port -gt 0) { $env:MIRROR_PORT = "$Port" }

if ($PermissionsOnly) { $env:MIRROR_MODE = "permissions" }
else                  { $env:MIRROR_TRANSCRIPT = $transcript }

if ($PermissionsOnly -or $allowSend -eq 1) {
    if (-not $channelPort) { Die "this mode needs a channelPort in $IdentityFile" }
    $env:MIRROR_CHANNEL_URL   = "http://127.0.0.1:$channelPort"
    if (-not $env:MIRROR_STUB_IDENTITY) { $env:MIRROR_STUB_IDENTITY = "lupo|Lupo" }
}

$env:MIRROR_ALLOW_SEND      = "$allowSend"
$env:MIRROR_ALLOW_INTERRUPT = "$allowInterrupt"
$env:MIRROR_ALLOW_COMMANDS  = "$allowCommands"
$env:MIRROR_ALLOW_UPLOAD    = "$allowUpload"

if ($allowSend -eq 1)      { Write-Warning "input ENABLED - the browser can inject messages into your live session." }
if ($allowInterrupt -eq 1) { Write-Warning "interrupt ENABLED - but there is no tmux here; the route will fail rather than interrupt." }
if ($allowUpload -eq 1)    { Write-Warning "uploads ENABLED - the browser can write files into your inbox/." }

$modeDesc = if ($PermissionsOnly) { "permissions-only - NOTHING about this session is published" }
            else { "full - THIS PUBLISHES YOUR WHOLE SESSION" }

@"
instance   : $instance
mode       : $modeDesc
transcript : $(if ($transcript) { $transcript } else { "none (not read in permissions mode)" })
  chosen by: $sidSource
url        : http://${Bind}:$(if ($env:MIRROR_PORT) { $env:MIRROR_PORT } else { "<server default>" })$($env:MIRROR_BASE_PATH)
input      : $(if ($allowSend -eq 1) { "on (channel $channelPort)" } else { "off" })
grants     : send=$allowSend interrupt=$allowInterrupt commands=$allowCommands upload=$allowUpload
"@ | Write-Output

$server = Join-Path $MirrorHome "src\mirror-server.mjs"
if (-not (Test-Path $server)) { Die "server not found at $server" }

if ($WhatIf) { Write-Output "`n--- WhatIf: would exec: node $server ---"; exit 0 }
& node $server
