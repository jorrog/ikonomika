#!/usr/bin/env python3
"""Генерира js/map-data.js от GeoJSON с 28-те области на България.

Източник на данните: geoBoundaries (gbOpen, BGR, ADM1, simplified), Public Domain.
https://www.geoboundaries.org/

Употреба:
    python3 tools/build_map.py път/до/geoBoundaries-BGR-ADM1_simplified.geojson
"""
import collections
import heapq
import json
import math
import os
import sys

NAMES = {
    "BG-01": "Благоевград", "BG-02": "Бургас", "BG-03": "Варна",
    "BG-04": "Велико Търново", "BG-05": "Видин", "BG-06": "Враца",
    "BG-07": "Габрово", "BG-08": "Добрич", "BG-09": "Кърджали",
    "BG-10": "Кюстендил", "BG-11": "Ловеч", "BG-12": "Монтана",
    "BG-13": "Пазарджик", "BG-14": "Перник", "BG-15": "Плевен",
    "BG-16": "Пловдив", "BG-17": "Разград", "BG-18": "Русе",
    "BG-19": "Силистра", "BG-20": "Сливен", "BG-21": "Смолян",
    "BG-22": "София-град", "BG-23": "София-област", "BG-24": "Стара Загора",
    "BG-25": "Търговище", "BG-26": "Хасково", "BG-27": "Шумен",
    "BG-28": "Ямбол",
}

# Области, които се обединяват при 3 отбора (27 = 3 × 9).
MERGED = [{"id": "BG-SOF", "name": "София", "parts": ["BG-22", "BG-23"]}]

WIDTH = 1000
PAD = 12
LAT0 = math.radians(42.7)


def polylabel(ring, precision=0.5):
    """Точката във вътрешността, най-отдалечена от контура (pole of inaccessibility)."""
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)

    def signed_dist(x, y):
        inside = False
        best = float("inf")
        n = len(ring)
        for i in range(n):
            ax, ay = ring[i]
            bx, by = ring[(i + 1) % n]
            if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
                inside = not inside
            dx, dy = bx - ax, by - ay
            t = 0.0
            if dx or dy:
                t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
            ex, ey = ax + t * dx - x, ay + t * dy - y
            best = min(best, ex * ex + ey * ey)
        return math.sqrt(best) * (1 if inside else -1)

    cell = min(maxx - minx, maxy - miny)
    h = cell / 2
    heap = []

    def push(x, y, h):
        d = signed_dist(x, y)
        heapq.heappush(heap, (-(d + h * math.sqrt(2)), x, y, h, d))

    x = minx
    while x < maxx:
        y = miny
        while y < maxy:
            push(x + h, y + h, h)
            y += cell
        x += cell
    cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
    best = (signed_dist(cx, cy), cx, cy)
    while heap:
        _, x, y, h, d = heapq.heappop(heap)
        if d > best[0]:
            best = (d, x, y)
        if d + h * math.sqrt(2) - best[0] <= precision:
            continue
        h /= 2
        for ox in (-h, h):
            for oy in (-h, h):
                push(x + ox, y + oy, h)
    return best[1], best[2], best[0]


def key(p):
    return (round(p[0], 6), round(p[1], 6))


def signed_area(ring):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:] + ring[:1])) / 2


def union_rings(rings):
    """Обединява съседни полигони с общи ръбове: общите ръбове се махат, останалите се свързват в контур."""
    norm = []
    for r in rings:
        r = [key(p) for p in r]
        if r[0] == r[-1]:
            r = r[:-1]
        if signed_area(r) < 0:
            r = r[::-1]
        norm.append(r)
    directed = [e for r in norm for e in zip(r, r[1:] + r[:1])]
    present = set(directed)
    nxt = collections.defaultdict(list)
    for a, b in directed:
        if (b, a) not in present:
            nxt[a].append(b)
    out = []
    while any(nxt.values()):
        start = next(k for k, v in nxt.items() if v)
        ring = [start]
        cur = nxt[start].pop()
        while cur != start:
            ring.append(cur)
            cur = nxt[cur].pop()
        out.append(ring)
    out.sort(key=lambda r: -abs(signed_area(r)))
    return out


def main(src):
    gj = json.load(open(src, encoding="utf-8"))
    feats = gj["features"]
    all_pts = [p for f in feats for r in f["geometry"]["coordinates"] for p in r]
    lon_min = min(p[0] for p in all_pts)
    lon_max = max(p[0] for p in all_pts)
    lat_min = min(p[1] for p in all_pts)
    lat_max = max(p[1] for p in all_pts)
    k = (WIDTH - 2 * PAD) / ((lon_max - lon_min) * math.cos(LAT0))
    height = round((lat_max - lat_min) * k + 2 * PAD)

    def proj(p):
        return (round((p[0] - lon_min) * math.cos(LAT0) * k + PAD, 1),
                round((lat_max - p[1]) * k + PAD, 1))

    def shape(src_rings, iso, name):
        rings = []
        for r in src_rings:
            pts = []
            for p in r:
                q = proj(p)
                if not pts or pts[-1] != q:
                    pts.append(q)
            if pts[0] == pts[-1]:
                pts.pop()
            rings.append(pts)
        d = " ".join("M" + " L".join(f"{x:g},{y:g}" for x, y in ring) + "Z" for ring in rings)
        lx, ly, r = polylabel(rings[0])
        return {"id": iso, "name": name, "d": d, "label": [round(lx, 1), round(ly, 1)], "r": round(r, 1)}

    edges = collections.defaultdict(set)
    provinces = []
    source = {}
    for f in feats:
        iso = f["properties"]["shapeISO"]
        source[iso] = f["geometry"]["coordinates"]
        for r in source[iso]:
            for a, b in zip(r, r[1:]):
                edges[tuple(sorted([key(a), key(b)]))].add(iso)
        provinces.append(shape(source[iso], iso, NAMES[iso]))

    neighbors = collections.defaultdict(set)
    for s in edges.values():
        if len(s) == 2:
            a, b = sorted(s)
            neighbors[a].add(b)
            neighbors[b].add(a)
    for p in provinces:
        p["neighbors"] = sorted(neighbors[p["id"]])
    provinces.sort(key=lambda p: p["id"])

    merged = []
    for m in MERGED:
        rings = union_rings([r for part in m["parts"] for r in source[part]])
        entry = shape(rings, m["id"], m["name"])
        entry["parts"] = m["parts"]
        entry["neighbors"] = sorted({n for part in m["parts"] for n in neighbors[part]} - set(m["parts"]))
        merged.append(entry)

    out = os.path.join(os.path.dirname(__file__), "..", "js", "map-data.js")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("// Генерирано от tools/build_map.py — не редактирайте ръчно.\n")
        fh.write("// Граници: geoBoundaries (gbOpen BGR ADM1), Public Domain.\n")
        fh.write("window.BG_MAP = ")
        json.dump({"width": WIDTH, "height": height, "provinces": provinces, "merged": merged},
                  fh, ensure_ascii=False, separators=(",", ":"))
        fh.write(";\n")
    print(f"OK: {len(provinces)} области + {len(merged)} обединени, {WIDTH}x{height}, {os.path.getsize(out) // 1024} KB -> {os.path.normpath(out)}")


if __name__ == "__main__":
    main(sys.argv[1])
