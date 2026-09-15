import { CredentialsSignin } from "next-auth";
import { INVALID_TWO_FACTOR_CODE, TWO_FACTOR_REQUIRED } from "./two-factor-codes";

/**
 * Thrown from the Credentials provider's `authorize` (lib/auth/authorize.ts).
 * As `CredentialsSignin` subclasses, Auth.js never creates a session for
 * them and forwards `code` to the client's `signIn()` result.
 */
export class TwoFactorRequiredError extends CredentialsSignin {
  code = TWO_FACTOR_REQUIRED;
}

export class InvalidTwoFactorCodeError extends CredentialsSignin {
  code = INVALID_TWO_FACTOR_CODE;
}
