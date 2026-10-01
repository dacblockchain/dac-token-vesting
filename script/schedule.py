#!/usr/bin/env python3
"""Generates the README's allocation, floating-supply and unlock-rate tables from one TGE.

Source of truth for the buckets is script/Deploy.s.sol; the script fails if the copies in
script/safe-funding-batch.py or ui/core.js disagree. The TGE defaults to MAINNET_TGE in
ui/core.js (the deploy page's default), so changing the date is: edit that constant, then
run this script with --write.

Usage:
  ./script/schedule.py                # print the tables
  ./script/schedule.py --write        # rewrite the marked blocks in README.md
  ./script/schedule.py --tge 1792627200 --write
"""
import argparse, datetime as dt, pathlib, re, sys
from fractions import Fraction as Fr

ROOT = pathlib.Path(__file__).resolve().parent.parent
MONTH = 30 * 86400
SUPPLY = 1_000_000_000
LABELS = {
    "TEAM": "Team", "MARKETING": "Marketing", "ENTERPRISE": "Enterprise", "INSTITUTIONAL": "Institutional",
    "INSTITUTIONAL_UNICORN": "Institutional (Unicorn)", "GRANT_AIRDROP": "Grant / Airdrop", "RESERVE": "Reserve",
}


def read(rel):
    return (ROOT / rel).read_text()


def load_grants():
    sol = re.findall(r'_grant\("(\w+)", owner, mainnet, (\d+), (\d+), ([\d_]+)e18\)', read("script/Deploy.s.sol"))
    grants = [(n, int(c), int(v), int(a.replace("_", ""))) for n, c, v, a in sol]
    py = [(n, int(c), int(v), int(a.replace("_", ""))) for n, c, v, a in
          re.findall(r'\("(\w+)", (\d+), (\d+), ([\d_]+)\)', read("script/safe-funding-batch.py"))]
    js = [(n, int(c), int(v), int(a.replace("_", ""))) for n, c, v, a in
          re.findall(r'\{ name: "(\w+)", cliff: (\d+), vesting: (\d+), amount: ([\d_]+)n \}', read("ui/core.js"))]
    for name, other in (("script/safe-funding-batch.py", py), ("ui/core.js", js)):
        if other != grants:
            sys.exit(f"bucket list in {name} differs from script/Deploy.s.sol:\n  {other}\n  {grants}")
    if not grants:
        sys.exit("no grants parsed from script/Deploy.s.sol")
    return grants


def page_tge():
    m = re.search(r"const MAINNET_TGE = (\d+);", read("ui/core.js"))
    return int(m.group(1))


def tables(tge, grants):
    day = lambda m: dt.datetime.fromtimestamp(tge + m * MONTH, dt.timezone.utc).strftime("%Y-%m-%d")
    vest_total = sum(g[3] for g in grants)
    outside = SUPPLY - vest_total
    lab = lambda n: LABELS.get(n, n.title())
    fmt = lambda x: f"{round(x):,}"

    alloc = ["| Bucket | DACT | % supply | Cliff | Vesting | Vesting starts | Fully vested | Unlock per month while vesting |",
             "| --- | ---: | ---: | ---: | ---: | --- | --- | ---: |"]
    for n, c, v, a in grants:
        alloc.append(f"| {lab(n)} | {a:,} | {a / SUPPLY:.1%} | {f'{c}m' if c else '0'} | {v}m | {day(c)} | {day(c + v)} | {fmt(Fr(a, v))} |")
    alloc += [f"| **In vesting wallets** | **{vest_total:,}** | **{vest_total / SUPPLY:.1%}** | | | | | |",
              f"| **Outside vesting** | **{outside:,}** | **{outside / SUPPLY:.1%}** | | | | | |"]

    def vested(m):
        return sum((a * min(Fr(1), Fr(m - c, v)) for n, c, v, a in grants if m > c), Fr(0))

    starts = {}
    ends = {}
    for n, c, v, a in grants:
        starts.setdefault(c, []).append(lab(n))
        ends.setdefault(c + v, []).append(lab(n))
    last = max(ends)
    months = sorted({0, 1, 6, 9, 18, 30, 42, 54} | set(starts) | set(ends))

    def event(m):
        parts = []
        if m == 0:
            parts.append("TGE")
        if m in starts:
            who = " and ".join(starts[m]) if len(starts[m]) < 3 else ", ".join(starts[m][:-1]) + " and " + starts[m][-1]
            parts.append(f"{who} start{'s' if len(starts[m]) == 1 else ''} vesting" + (f" ({m}-month cliff ends)" if m else ""))
        if m in ends:
            who = " and ".join(ends[m])
            parts.append(f"{who} fully vested" + (": everything unlocked" if m == last else ""))
        return ". ".join(parts)

    flt = ["| Month | Date | Unlocked from vesting | Still locked | Floating supply | % of supply | Event |",
           "| ---: | --- | ---: | ---: | ---: | ---: | --- |"]
    for m in months:
        u = vested(m)
        f = outside + u
        flt.append(f"| {m} | {day(m)} | {fmt(u)} | {fmt(vest_total - u)} | **{fmt(f)}** | {float(f) / SUPPLY:.1%} | {event(m)} |")

    bounds = sorted(set(starts) | set(ends))
    rates = ["| Months | Buckets vesting | New floating supply per month |", "| --- | --- | ---: |"]
    for lo, hi in zip(bounds, bounds[1:]):
        active = [(n, a, v) for n, c, v, a in grants if c <= lo and hi <= c + v]
        names = ", ".join(lab(n) for n, _, _ in active) if len(active) < len(grants) else f"all {len(grants)} (peak)"
        rates.append(f"| {lo}–{hi} | {names} | {fmt(sum(Fr(a, v) for _, a, v in active))} |")
    return {"allocation": "\n".join(alloc), "floating": "\n".join(flt), "rates": "\n".join(rates)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tge", type=int, default=None, help="unix seconds (default: MAINNET_TGE in ui/core.js)")
    ap.add_argument("--write", action="store_true", help="rewrite the marked blocks in README.md")
    args = ap.parse_args()
    tge = args.tge or page_tge()
    grants = load_grants()
    blocks = tables(tge, grants)
    when = dt.datetime.fromtimestamp(tge, dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    if not args.write:
        print(f"TGE {tge} ({when})\n")
        for k, v in blocks.items():
            print(f"<!-- {k} -->\n{v}\n")
        return
    readme = read("README.md")
    for k, v in blocks.items():
        pat = re.compile(rf"(<!-- schedule:{k}:start -->\n).*?(\n<!-- schedule:{k}:end -->)", re.S)
        if not pat.search(readme):
            sys.exit(f"README.md has no <!-- schedule:{k}:start/end --> markers")
        readme = pat.sub(lambda m: m.group(1) + v + m.group(2), readme)
    (ROOT / "README.md").write_text(readme)
    stale = sorted({int(x) for x in re.findall(r"TGE_TIMESTAMP=(\d{9,})", readme)} - {tge})
    print(f"README.md tables regenerated for TGE {tge} ({when})")
    if stale:
        sys.exit(f"README.md still mentions TGE_TIMESTAMP values {stale}; update the prose by hand")


if __name__ == "__main__":
    main()
