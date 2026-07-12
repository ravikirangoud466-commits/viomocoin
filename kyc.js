'use strict';
/*
 * KYC (identity verification) policy.
 *
 * No third-party KYC provider SDK is bundled, so the behaviour is config-driven:
 *   - In development (NODE_ENV !== 'production') submissions are AUTO-APPROVED so
 *     the demo flow works end-to-end without a provider.
 *   - In production they default to 'pending' and must be approved by the platform
 *     owner (Moderation -> KYC), OR you wire a real provider (Onfido, Persona,
 *     Stripe Identity, Razorpay) and approve via its callback.
 *   - Override explicitly with KYC_AUTO_APPROVE=true / =false.
 *
 * This exists so a real-money deployment never auto-verifies creators by accident.
 */
const IS_PROD = process.env.NODE_ENV === 'production';
const RAW = process.env.KYC_AUTO_APPROVE;
// A blank/unset value means "use the default" (auto-approve in dev, manual in prod);
// only an explicit "true"/"false" overrides it.
const AUTO = (RAW === undefined || RAW === '') ? !IS_PROD : RAW === 'true';

module.exports = {
  autoApprove: AUTO,
  // The status a freshly-submitted KYC record should get.
  initialStatus() {
    return AUTO ? 'verified' : 'pending';
  },
};
