#!/bin/sh
set -eu

profile_dir=${1:-/data/browser}

rm -f \
  "$profile_dir/SingletonLock" \
  "$profile_dir/SingletonSocket" \
  "$profile_dir/SingletonCookie"
