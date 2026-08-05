import { startSeeded } from "./server";

export default async function globalSetup() {
  await startSeeded();
}
