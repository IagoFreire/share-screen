import path from "node:path";

/** What the app is called everywhere a person sees it. */
export const APP_NAME = "Janja";

/**
 * The folder logins and settings live in. It keeps the name the app shipped with,
 * "ScreenShare": Electron would otherwise follow the new product name to a fresh
 * folder, logging everyone out and forgetting their choices on the update.
 */
const USER_DATA_FOLDER = "ScreenShare";

export function userDataPath(appDataPath: string): string {
  return path.join(appDataPath, USER_DATA_FOLDER);
}
