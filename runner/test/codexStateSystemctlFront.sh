#!/bin/sh
# Shell front for the Codex state fixture's fake systemctl (issue 797).
# Answers the read-only queries the product issues without starting Node, and
# runs the unchanged Node script for everything else. Every decision is made
# before any side effect, so a delegated call behaves exactly as without the
# front. The comparison with the Node script is codexStateFixtureSystemctl.test.ts.
d=@DIR@
impl=@IMPL@
shim=@SHIM@
conf=@CONF@
ordinary=@ORDINARY@

# Observation only: the answer is the same with or without a recording.
if [ -n "${KAOIRO_FIXTURE_SYSTEMCTL_RECORD:-}" ]; then
  {
    for arg in "$@"; do printf '%s\037' "$arg"; done
    printf '\036\n'
  } 2> /dev/null >> "$KAOIRO_FIXTURE_SYSTEMCTL_RECORD" || :
fi

slow() { exec "$impl" "$@"; }

# Verbs are whole argv elements, in the Node script's priority: stop and start
# first, then show-environment, then show. The first --property= wins; -p is
# not interpreted.
want_env=0
want_show=0
have_prop=0
prop=
for arg in "$@"; do
  case $arg in
    stop | start) slow "$@" ;;
    show-environment) want_env=1 ;;
    show) want_show=1 ;;
    --property=*)
      if [ $have_prop = 0 ]; then
        have_prop=1
        prop=${arg#--property=}
      fi
      ;;
  esac
done
[ $want_env = 1 ] || [ $want_show = 1 ] || slow "$@"

# A rewritten fake (tests inject faults by editing it) is served by Node.
cmp -s "$impl" "$d/systemctl.pristine" 2> /dev/null || slow "$@"

# active is compared as a whole string by the Node script. A zero status from
# read means a newline was present, so the content is not exactly "active".
# read also drops NUL bytes silently, so a value that passes the checks below
# must still be the file's exact bytes (cmp), or Node answers.
[ -f "$d/mainpid" ] || slow "$@"
[ -f "$d/active" ] || slow "$@"
m=
if IFS= read -r m < "$d/mainpid"; then slow "$@"; fi
act=
if IFS= read -r act < "$d/active"; then slow "$@"; fi
if [ "$act" = active ]; then
  printf '%s' "$act" | cmp -s - "$d/active" 2> /dev/null || slow "$@"
fi
p=${m#'{"pid":'}
p=${p%%,*}
s=${m#*',"start":"'}
s=${s%'"}'}
case $p in '' | *[!0-9]* | 0*) slow "$@" ;; esac
case $s in '' | *[!0-9]*) slow "$@" ;; esac
[ "${#p}" -le 15 ] || slow "$@"
[ "$m" = '{"pid":'"$p"',"start":"'"$s"'"}' ] || slow "$@"
printf '%s' "$m" | cmp -s - "$d/mainpid" 2> /dev/null || slow "$@"

if [ $want_env = 1 ]; then
  [ ! -e "$d/manager-extra" ] || slow "$@"
  { printf '%s\n' show-environment; } 2> /dev/null >> "$d/queries" || slow "$@"
  printf 'HOME=%s\nKAOIRO_RUNNER_DIR=%s\n' "$ordinary" "$conf"
  exit 0
fi

case $prop in
  Transient) v=no ;;
  ExecStart | '') v="{ path=$shim ; argv[]=$shim ; ignore_errors=no }" ;;
  KillMode) v=control-group ;;
  Id) v=kogane468-test.service ;;
  MainPID) if [ "$act" = active ]; then v=$p; else v=0; fi ;;
  ActiveState)
    [ ! -e "$d/activity-fault" ] || slow "$@"
    if [ "$act" = active ]; then v=active; else v=inactive; fi
    ;;
  ControlGroup) v=/kaoiro-test ;;
  ExecStartPre | ExecStartPost | EnvironmentFiles | PassEnvironment | RootDirectory | RootImage | Environment | UnsetEnvironment) v= ;;
  *) slow "$@" ;;
esac
{ printf '%s\n' "${prop:-ExecStart}"; } 2> /dev/null >> "$d/queries" || slow "$@"
printf '%s\n' "$v"
