#!/usr/bin/env python3
"""
多项目状态渲染器：读取所有在跑项目的状态，自适应分区画小圆灯，发到 K28。

布局（按活跃项目数自适应）：
  1 个   → 居中一个大圆灯
  2 个   → 左右两个圆灯
  3-4 个 → 四宫格四个圆灯
  5-9 个 → 3×3 九个小圆灯
颜色：busy=黄 / done=绿 / attention=红。无活跃窗口时显示一个低亮圆环作为保底。
状态文件：~/.claude/k28-status-light/states/<cwd哈希>.txt  内容: state\tepoch\tname
TTL 内（默认1小时）才显示；过期自动清理。多 hook 同时触发用文件锁串行，避免抢设备。
"""
import asyncio
import fcntl
import glob
import os
import time

from bleak import BleakClient, BleakScanner

DIR = os.path.expanduser("~/.claude/k28-status-light")
STATES = os.path.join(DIR, "states")
LOCK = os.path.join(DIR, ".render.lock")
ADDR_CACHE = os.path.expanduser("~/.k28_addr")
AE01 = "0000ae01-1111-0000-8000-00805f9b36fb"
APPLY = bytes.fromhex("55b6010000000088")
DEVICE_NAME = "ERAZER K28LED"
TTL = 3600  # 1 小时（窗口关闭由 SessionEnd 立即清除；TTL 只给崩溃/异常退出兜底）

COLORS = {"busy": (179, 255, 0), "done": (0, 51, 0), "attention": (255, 0, 0)}
IDLE_RING = {
    "outer": (0, 85, 0),
    "inner": (0, 34, 0),
    "center": (0, 128, 0),
}


def read_states():
    """读取未过期的项目状态，按 cwd 哈希(文件名)稳定排序，保证每个项目位置固定。"""
    items, now = [], time.time()
    for f in sorted(glob.glob(os.path.join(STATES, "*.txt"))):
        try:
            parts = open(f).read().strip().split("\t")
            state, ts, name = parts[0], parts[1], parts[2]
            ts = float(ts)
        except Exception:
            continue
        if now - ts > TTL:
            try:
                os.remove(f)
            except OSError:
                pass
            continue
        items.append((state, name))
    return items


def disc(colors, cy, cx, r2, color):
    for y in range(11):
        for x in range(11):
            if (y - cy) ** 2 + (x - cx) ** 2 <= r2:
                colors[y * 11 + x] = color


HEART = [
    "...........",
    "..XX...XX..",
    ".XXXX.XXXX.",
    ".XXXXXXXXX.",
    ".XXXXXXXXX.",
    "..XXXXXXX..",
    "...XXXXX...",
    "....XXX....",
    ".....X.....",
    "...........",
    "...........",
]
HEART_COLOR = (160, 30, 40)  # 柔和红粉


def idle_mark(colors):
    """无活跃窗口时的待机标识：柔和爱心，表示状态灯在线。"""
    for y in range(11):
        for x in range(11):
            if HEART[y][x] == "X":
                colors[y * 11 + x] = HEART_COLOR


# 各数量的对称布局：(行,列,半径²)。重新设计，圆灯均匀对称、不挤不糊。
LAYOUTS = {
    1: [(5, 5, 20)],
    2: [(5, 2, 6), (5, 8, 6)],
    3: [(2, 2, 5), (2, 8, 5), (8, 5, 5)],                                   # 2上 + 1下居中
    4: [(2, 2, 5), (2, 8, 5), (8, 2, 5), (8, 8, 5)],                        # 四宫格
    5: [(2, 2, 4), (2, 8, 4), (8, 2, 4), (8, 8, 4), (5, 5, 2)],             # 四角 + 中心
    6: [(3, 1, 2), (3, 5, 2), (3, 9, 2), (7, 1, 2), (7, 5, 2), (7, 9, 2)],  # 2行×3列
    7: [(1, 1, 2), (1, 5, 2), (1, 9, 2), (5, 5, 2), (9, 1, 2), (9, 5, 2), (9, 9, 2)],  # 3上+1中+3下
    8: [(1, 1, 2), (1, 5, 2), (1, 9, 2), (5, 1, 2), (5, 9, 2), (9, 1, 2), (9, 5, 2), (9, 9, 2)],  # 环形
    9: [(1, 1, 2), (1, 5, 2), (1, 9, 2), (5, 1, 2), (5, 5, 2), (5, 9, 2), (9, 1, 2), (9, 5, 2), (9, 9, 2)],  # 3×3
}


def build_colors(items):
    colors = [(0, 0, 0)] * 121
    states = [s for s, _ in items]
    n = min(len(states), 9)
    if n == 0:
        idle_mark(colors)
        return colors
    for (cy, cx, r2), s in zip(LAYOUTS[n], states[:9]):
        disc(colors, cy, cx, r2, COLORS.get(s, (0, 0, 0)))
    return colors


def build_frame(colors):
    """11x11 整帧（列优先转置）。"""
    frame = bytearray(4 + 242 + 2)
    frame[0:4] = bytes([0x55, 0xB1, 0x00, 0x00])
    for row in range(11):
        for col in range(11):
            r, g, b = colors[row * 11 + col]
            v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
            di = col * 11 + row
            frame[4 + di * 2] = v & 0xFF
            frame[4 + di * 2 + 1] = (v >> 8) & 0xFF
    frame[4 + 242:4 + 244] = bytes([0x00, 0x88])
    return bytes(frame)


async def find_address():
    if os.path.exists(ADDR_CACHE):
        a = open(ADDR_CACHE).read().strip()
        if a:
            return a
    dev = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=10.0)
    if not dev:
        raise SystemExit("device not found")
    open(ADDR_CACHE, "w").write(dev.address)
    return dev.address


async def send(frame):
    addr = await find_address()
    try:
        async with BleakClient(addr, timeout=10.0) as cl:
            await cl.write_gatt_char(AE01, frame, response=True)
            await cl.write_gatt_char(AE01, APPLY, response=True)
    except Exception:
        if os.path.exists(ADDR_CACHE):
            os.remove(ADDR_CACHE)
        dev = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=10.0)
        if not dev:
            raise
        open(ADDR_CACHE, "w").write(dev.address)
        async with BleakClient(dev, timeout=10.0) as cl:
            await cl.write_gatt_char(AE01, frame, response=True)
            await cl.write_gatt_char(AE01, APPLY, response=True)


def main():
    lf = open(LOCK, "w")
    fcntl.flock(lf, fcntl.LOCK_EX)  # 串行：同一时刻只一个渲染连设备
    try:
        frame = build_frame(build_colors(read_states()))
        asyncio.run(send(frame))
    finally:
        fcntl.flock(lf, fcntl.LOCK_UN)
        lf.close()


if __name__ == "__main__":
    main()
