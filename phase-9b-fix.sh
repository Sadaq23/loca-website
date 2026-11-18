#!/usr/bin/env bash
# ============================================================
# PHASE 9-B: REPAIR public/admin/config.yml
# Fixes the "[ERROR] config.yml verification failed" from phase 9.
# What it does (and nothing else):
#   - moves base_url + auth_endpoint INSIDE the backend block
#   - sets site_url + display_url to https://www.localliance.org
#   - removes old pkce keys (auth_type / app_id) if still present
#   - keeps everything else (media folders, collections) untouched
# Safe to run more than once (idempotent). Run from the project root.
# ============================================================
set -e

CFG="public/admin/config.yml"
SITE_URL="https://www.localliance.org"

echo "--- PHASE 9-B: REPAIR CMS CONFIG (public/admin/config.yml) ---"

if [ ! -f "$CFG" ]; then
  echo "  [ERROR] $CFG not found. Run this from the project root (~/website-local)"
  exit 1
fi

# 1) backup (keeps the newest 5)
cp "$CFG" "$CFG.bak-$(date +%Y%m%d-%H%M%S)"
ls -1t "$CFG".bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f
echo "  [OK]    Backup saved (config.yml.bak-*)"

# 2) show what the file looks like now
echo ""
echo "  ---- config.yml BEFORE (top 40 lines) ----"
sed -n '1,40p' "$CFG"
echo "  -------------------------------------------"

# 3) repair the four keys, leave the rest alone
TMP="$(mktemp)"
awk -v site="$SITE_URL" '
  function flush_backend() {
    if (in_backend == 1 && wrote_be == 0) {
      print be_indent "base_url: " site
      print be_indent "auth_endpoint: api/auth"
      wrote_be = 1
    }
  }
  BEGIN { in_backend = 0; saw_backend = 0; wrote_be = 0; wrote_top = 0; be_indent = "  " }
  {
    line = $0
    sub(/\r$/, "", line)

    if (line ~ /^backend:[[:space:]]*(#.*)?$/) {
      saw_backend = 1; in_backend = 1; wrote_be = 0
      print line; next
    }
    # drop old copies of the keys we manage (any indent, any value)
    if (line ~ /^[[:space:]]*(base_url|auth_endpoint|auth_type|app_id):/) next
    if (line ~ /^(site_url|display_url):/) next
    # remember the indent used inside the backend block
    if (in_backend == 1 && line ~ /^[[:space:]]+[A-Za-z_][A-Za-z0-9_-]*:/) {
      match(line, /^[[:space:]]+/)
      be_indent = substr(line, RSTART, RLENGTH)
    }
    # a new top-level key ends the backend block
    if (in_backend == 1 && line ~ /^[A-Za-z_][A-Za-z0-9_-]*:/) {
      flush_backend()
      in_backend = 0
      if (wrote_top == 0) {
        print "site_url: " site
        print "display_url: " site
        wrote_top = 1
      }
      print line; next
    }
    print line
  }
  END {
    flush_backend()
    if (saw_backend == 0) {
      print "backend:"
      print "  name: github"
      print "  repo: Sadaq23/loca-website"
      print "  branch: main"
      print "  base_url: " site
      print "  auth_endpoint: api/auth"
      print "site_url: " site
      print "display_url: " site
    } else if (wrote_top == 0) {
      print "site_url: " site
      print "display_url: " site
    }
  }
' "$CFG" > "$TMP"
mv "$TMP" "$CFG"
echo "  [OK]    config.yml rewritten (4 keys normalised, rest untouched)"

# 4) verify - every check must pass
FAIL=0
if ! grep -q '^backend:' "$CFG"; then echo "  [FAIL]  backend: block missing"; FAIL=1; fi
if ! grep -Eq '^[[:space:]]+base_url: https://www\.localliance\.org$' "$CFG"; then echo "  [FAIL]  base_url not inside backend block"; FAIL=1; fi
if ! grep -Eq '^[[:space:]]+auth_endpoint: api/auth$' "$CFG"; then echo "  [FAIL]  auth_endpoint missing inside backend"; FAIL=1; fi
if ! grep -Eq '^site_url: https://www\.localliance\.org$' "$CFG"; then echo "  [FAIL]  site_url wrong"; FAIL=1; fi
if ! grep -Eq '^display_url: https://www\.localliance\.org$' "$CFG"; then echo "  [FAIL]  display_url wrong"; FAIL=1; fi
if grep -Eq 'localliance\.org/admin' "$CFG"; then echo "  [FAIL]  old /admin/ URLs still present"; FAIL=1; fi
if grep -Eq '^base_url:' "$CFG"; then echo "  [FAIL]  base_url still top-level (must be inside backend)"; FAIL=1; fi
if grep -Eq '^[[:space:]]*(auth_type|app_id):' "$CFG"; then echo "  [FAIL]  old pkce keys still present"; FAIL=1; fi

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "  ---- config.yml AFTER (still wrong - copy/paste this back) ----"
  cat "$CFG"
  exit 1
fi

# 5) show the repaired top of the file
echo ""
echo "  ---- config.yml AFTER (up to collections:) ----"
awk '/^collections:/ {exit} {print}' "$CFG"
echo "  ------------------------------------------------"

# 6) soft warnings + bonus checks
grep -Eq '^[[:space:]]+repo: ' "$CFG" || echo "  [WARN]  no 'repo:' line inside backend - check it"
grep -Eq '^[[:space:]]+branch: main' "$CFG" || echo "  [WARN]  no 'branch: main' inside backend - check it"

if grep -rqs "GITHUB_CLIENT_SECRET" functions 2>/dev/null; then
  echo "  [INFO]  OAuth function code : PRESENT (phase 9 created it before stopping)"
else
  echo "  [INFO]  OAuth function code : NOT FOUND yet - phase 9 stopped before creating it, re-run it next"
fi

if command -v node >/dev/null 2>&1 && [ -d node_modules/js-yaml ]; then
  CFG="$CFG" node -e 'const y=require("js-yaml"),fs=require("fs");try{y.load(fs.readFileSync(process.env.CFG,"utf8"));console.log("  [OK]    YAML parses cleanly")}catch(e){console.log("  [FAIL]  YAML error: "+e.message);process.exit(1)}'
fi

echo ""
echo "  [PASS]  config.yml is correct now"
echo ""
echo "  NEXT STEP: re-run phase 9:"
echo "             ./phase-9.sh"
echo "  It should now pass the config check and run to the end."
