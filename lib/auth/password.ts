import bcrypt from "bcryptjs";

/** Cost factor for every password hash — deliberately fixed, not env-tunable. */
const BCRYPT_COST = 12;

/** Never store or log a plaintext password — only ever this hash. */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
