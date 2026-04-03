let uploadLeaveHandler: null | (() => boolean | Promise<boolean>) = null;

export function registerUploadLeaveGuard(handler: null | (() => boolean | Promise<boolean>)) {
  uploadLeaveHandler = handler;
  return () => {
    if (uploadLeaveHandler === handler) {
      uploadLeaveHandler = null;
    }
  };
}

export async function requestUploadLeave() {
  if (!uploadLeaveHandler) return true;
  try {
    return await uploadLeaveHandler();
  } catch {
    return false;
  }
}
