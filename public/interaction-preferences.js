const RESUME_SKIP_CONFIRM_KEY = "allsessions_resume_skip_confirm";

export function shouldConfirmResume() {
  try {
    return localStorage.getItem(RESUME_SKIP_CONFIRM_KEY) !== "1";
  } catch {
    return true;
  }
}

export function setConfirmResume(confirm) {
  localStorage.setItem(RESUME_SKIP_CONFIRM_KEY, confirm ? "0" : "1");
}
