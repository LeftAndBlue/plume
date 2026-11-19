/**
 * CodeMirror 浮层共用的坐标空间。
 * client 坐标减去滚动容器原点并除以缩放倍率后，即可用于 layer/cursor 定位。
 */
export function markerSpace(view) {
  const rect = view.scrollDOM.getBoundingClientRect();
  const scaleX = view.scaleX || 1;
  const scaleY = view.scaleY || 1;
  return {
    left: rect.left - view.scrollDOM.scrollLeft * scaleX,
    top: rect.top - view.scrollDOM.scrollTop * scaleY,
    scaleX,
    scaleY,
  };
}
