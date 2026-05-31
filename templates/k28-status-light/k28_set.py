#!/usr/bin/env python3
"""
ERAZER K28LED 命令行纯色发送器（供 Claude Code hook 调用切换状态灯）。

用法：
    k28_set.py <颜色>
颜色可为预设名（busy/done/attention/red/green/yellow/blue/white/off）或 #RRGGBB。

协议见 docs/k28-led-protocol.md：
    ① 写帧  55 b1 00 00 + 242字节RGB565 + 00 88
    ② 应用  55 b6 01 00 00 00 00 88
纯色每像素相同，无需列优先转置。
"""
import asyncio
import os
import sys

from bleak import BleakClient, BleakScanner

DEVICE_NAME = "ERAZER K28LED"
AE01 = "0000ae01-1111-0000-8000-00805f9b36fb"
APPLY = bytes.fromhex("55b6010000000088")
ADDR_CACHE = os.path.expanduser("~/.k28_addr")

# 预设色（已按本屏硬件特性调过：红强绿弱）。值为 (R,G,B)。
PRESETS = {
    "busy": (179, 255, 0),     # 忙：柠檬黄
    "done": (0, 51, 0),        # 完成：绿
    "attention": (255, 0, 0),  # 需关注：红
    "red": (255, 0, 0),
    "green": (0, 51, 0),
    "yellow": (179, 255, 0),
    "blue": (0, 0, 255),
    "white": (255, 255, 255),
    "off": (0, 0, 0),
}


def parse_color(s: str):
    """颜色名或 #RRGGBB → (r,g,b)。"""
    s = s.strip().lower()
    if s in PRESETS:
        return PRESETS[s]
    if s.startswith("#"):
        s = s[1:]
    if len(s) == 6:
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
    raise SystemExit(f"未知颜色: {s}")


def build_frame(colors) -> bytes:
    """由行优先颜色数组 colors[row*11+col]=(r,g,b) 生成整帧（含列优先转置）。"""
    frame = bytearray(4 + 242 + 2)
    frame[0:4] = bytes([0x55, 0xB1, 0x00, 0x00])
    for row in range(11):
        for col in range(11):
            r, g, b = colors[row * 11 + col]
            v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
            di = col * 11 + row  # 设备列优先转置
            frame[4 + di * 2] = v & 0xFF
            frame[4 + di * 2 + 1] = (v >> 8) & 0xFF
    frame[4 + 242:4 + 242 + 2] = bytes([0x00, 0x88])
    return bytes(frame)


def build_lamp_frame(r, g, b) -> bytes:
    """居中圆灯形状（红绿灯那个圆，dist^2<=20），圆内上色、圆外熄灭。"""
    colors = [(0, 0, 0)] * 121
    for y in range(11):
        for x in range(11):
            if (y - 5) ** 2 + (x - 5) ** 2 <= 20:
                colors[y * 11 + x] = (r, g, b)
    return build_frame(colors)


async def find_address() -> str:
    """优先用缓存地址；否则扫描设备名并缓存。"""
    if os.path.exists(ADDR_CACHE):
        addr = open(ADDR_CACHE).read().strip()
        if addr:
            return addr
    dev = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=10.0)
    if not dev:
        raise SystemExit(f"未找到设备 {DEVICE_NAME}")
    with open(ADDR_CACHE, "w") as f:
        f.write(dev.address)
    return dev.address


async def main():
    if len(sys.argv) < 2:
        raise SystemExit("用法: k28_set.py <颜色|#RRGGBB>")
    r, g, b = parse_color(sys.argv[1])
    frame = build_lamp_frame(r, g, b)

    addr = await find_address()
    try:
        async with BleakClient(addr, timeout=10.0) as client:
            await client.write_gatt_char(AE01, frame, response=True)
            await client.write_gatt_char(AE01, APPLY, response=True)
    except Exception:
        # 缓存地址可能失效（换机/重配对）→ 清缓存重扫一次
        if os.path.exists(ADDR_CACHE):
            os.remove(ADDR_CACHE)
        dev = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=10.0)
        if not dev:
            raise
        with open(ADDR_CACHE, "w") as f:
            f.write(dev.address)
        async with BleakClient(dev, timeout=10.0) as client:
            await client.write_gatt_char(AE01, frame, response=True)
            await client.write_gatt_char(AE01, APPLY, response=True)


if __name__ == "__main__":
    asyncio.run(main())
