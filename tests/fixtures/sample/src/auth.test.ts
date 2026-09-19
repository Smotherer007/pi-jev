import { login } from "./auth.ts";

export function testLoginRejects(): boolean {
  return login("a", "b") === false;
}
