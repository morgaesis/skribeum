import { selectLocalDirectory } from "./vault";

export async function open(): Promise<string | null> {
  return selectLocalDirectory();
}
