#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

profile="$temporary/browser"
mkdir -p "$profile/Default"
printf 'keep' > "$profile/Default/Cookies"
printf 'lock' > "$profile/SingletonLock"
ln -s /tmp/nonexistent-singleton-socket "$profile/SingletonSocket"
printf 'cookie' > "$profile/SingletonCookie"

sh "$script_dir/cleanup-browser-profile.sh" "$profile"
sh "$script_dir/cleanup-browser-profile.sh" "$profile"

for singleton in SingletonLock SingletonSocket SingletonCookie; do
  if [ -e "$profile/$singleton" ] || [ -L "$profile/$singleton" ]; then
    echo "$singleton was not removed" >&2
    exit 1
  fi
done

if [ "$(cat "$profile/Default/Cookies")" != "keep" ]; then
  echo "profile data was modified" >&2
  exit 1
fi
