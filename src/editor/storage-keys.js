/**
 * localStorage 键的唯一来源。
 * 偏好类键参与设置备份（SETTINGS_KEYS）；草稿与会话是运行状态，不参与。
 */

export const DRAFT_KEY = "plume.recovery.v1";
export const SIDE_KEY = "plume.side";
export const SIDE_OPEN_KEY = "plume.sidebar";
export const SIDEBAR_WIDTH_KEY = "plume.sidebarWidth";
export const IMAGE_FOLDER_KEY = "plume.imageFolder.v1";
export const IMAGE_UPLOAD_MODE_KEY = "plume.imageUploadMode.v1";
export const IMAGE_UPLOAD_PROVIDER_KEY = "plume.imageUploadProvider.v1";
export const PICGO_URL_KEY = "plume.picgoUrl.v1";
export const EASYIMAGE_URL_KEY = "plume.easyimageUrl.v1";
export const EASYIMAGE_TOKEN_KEY = "plume.easyimageToken.v1";
export const RECENT_KEY = "plume.recent";
export const SESSION_KEY = "plume.session.v1";
export const LOCALE_KEY = "plume.locale";

/** theme.js 的外观偏好（含主题）。theme.js 内部另有同名常量，改动时两处同步。 */
export const APPEARANCE_KEY = "markline.appearance.v1";

/** 设置备份覆盖的键（白名单，导入时也只认这些）。 */
export const SETTINGS_KEYS = [
  APPEARANCE_KEY,
  IMAGE_FOLDER_KEY,
  IMAGE_UPLOAD_MODE_KEY,
  IMAGE_UPLOAD_PROVIDER_KEY,
  PICGO_URL_KEY,
  EASYIMAGE_URL_KEY,
  EASYIMAGE_TOKEN_KEY,
  SIDE_KEY,
  SIDE_OPEN_KEY,
  SIDEBAR_WIDTH_KEY,
  RECENT_KEY,
  LOCALE_KEY,
];