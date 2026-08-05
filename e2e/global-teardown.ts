import { stopSeeded } from "./server";

export default async function globalTeardown() {
  await stopSeeded();
}
