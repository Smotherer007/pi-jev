// authentication helpers
export function login(user: string, password: string) {
  return validateCredentials(user, password);
}

function validateCredentials(_user: string, _password: string): boolean {
  return false;
}
