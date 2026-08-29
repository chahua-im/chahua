export const MEDIA_CONSTANTS = {
  // 图片/视频之间的间距
  GAP: 2,
  // 模糊效果半径
  BLUR_RADIUS: '20px',
  // 暗化背景，防止亮图模糊后文字看不清或对比度太弱
  BLUR_OVERLAY_OPACITY: 0.2,
};

export const getSingleMediaBounds = () => {
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 400;
  return {
    MAX_WIDTH: vw * 0.8,
    MAX_HEIGHT: vh * 0.5,
    MIN_WIDTH: 120, // 高窄图的最小宽度保障
    MIN_HEIGHT: 80, // 宽扁图的最小高度保障
  };
};
export const MIN_PREVIEW_AR = 0.15;
export const MAX_PREVIEW_AR = 10.0;

/** Fallback dimension when attachment width/height metadata is missing. */
export const FALLBACK_DIMENSION = 100;

export const MAX_ATTACHMENTS_PER_MESSAGE = 20; // 单条消息最多可发图数
export const MAX_ATTACHMENT_PREVIEWS = 6; // 多图网格最高预览数量
