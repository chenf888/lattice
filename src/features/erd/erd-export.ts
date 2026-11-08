/** ER 图导出：SVG 序列化下载 / SVG→canvas→PNG 字节（经 Rust 落盘） */

import { api } from "@/lib/ipc";

function pickPath(defaultName: string): Promise<string | null> {
  return api.pickSavePath(defaultName);
}

/** 导出 SVG（矢量原文） */
export async function exportSvg(svgElement: SVGSVGElement): Promise<void> {
  const serialized = new XMLSerializer().serializeToString(svgElement);
  const text = `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}`;
  const path = await pickPath("erd.svg");
  if (!path) {
    return;
  }
  const bytes = Array.from(new TextEncoder().encode(text));
  await api.saveBinaryFile(path, bytes);
}

/** 导出 PNG（经 canvas 栅格化，2x 分辨率） */
export async function exportPng(
  svgElement: SVGSVGElement,
  contentWidth: number,
  contentHeight: number,
): Promise<void> {
  const serialized = new XMLSerializer().serializeToString(svgElement);
  const svgBlob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("SVG 渲染失败"));
      element.src = url;
    });
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(contentWidth * scale));
    canvas.height = Math.max(1, Math.ceil(contentHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("无法创建画布");
    }
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, contentWidth, contentHeight);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) {
      throw new Error("PNG 编码失败");
    }
    const path = await pickPath("erd.png");
    if (!path) {
      return;
    }
    const buffer = await blob.arrayBuffer();
    await api.saveBinaryFile(path, Array.from(new Uint8Array(buffer)));
  } finally {
    URL.revokeObjectURL(url);
  }
}
