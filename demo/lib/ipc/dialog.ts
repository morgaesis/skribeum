import { selectLocalDirectory } from "./vault";

export async function open(): Promise<string | null> {
  const demoWindow = window as Window & {
    __SKRIBEUM_E2E_VAULT_PICKER_CALLS__?: number;
  };
  if (typeof demoWindow.__SKRIBEUM_E2E_VAULT_PICKER_CALLS__ === "number") {
    demoWindow.__SKRIBEUM_E2E_VAULT_PICKER_CALLS__ += 1;
  }
  return selectLocalDirectory();
}
