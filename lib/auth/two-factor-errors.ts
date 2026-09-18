import { CredentialsSignin } from "next-auth";
import {
  ACCOUNT_LOCKED,
  EMAIL_VERIFICATION_LOCKED,
  HUMAN_CHECK_FAILED,
  HUMAN_CHECK_REQUIRED,
  INVALID_TWO_FACTOR_CODE,
  IP_RATE_LIMITED,
  TWO_FACTOR_REQUIRED,
  timedCode,
} from "./two-factor-codes";

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

export class AccountLockedError extends CredentialsSignin {
  constructor(until: Date) {
    super();
    this.code = timedCode(ACCOUNT_LOCKED, until);
  }
}

export class IpRateLimitedError extends CredentialsSignin {
  constructor(until: Date) {
    super();
    this.code = timedCode(IP_RATE_LIMITED, until);
  }
}

export class EmailVerificationLockedError extends CredentialsSignin {
  code = EMAIL_VERIFICATION_LOCKED;
}

export class HumanCheckRequiredError extends CredentialsSignin {
  code = HUMAN_CHECK_REQUIRED;
}

export class HumanCheckFailedError extends CredentialsSignin {
  code = HUMAN_CHECK_FAILED;
}
