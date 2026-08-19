/**
 * Guest (credential-less) sessions, ported from `pvpn_cli/auth.py`.
 *
 * The login is two phases: an anonymous session first, then the credential-less
 * upgrade that yields a usable VPN session. If Proton asks for human
 * verification the whole flow is retried with the next Android device profile,
 * which is why the site keeps a pool of them instead of a single hardcoded one.
 *
 * Sessions also renew: the refresh token handed out at login is exchanged for a
 * fresh token pair at `/auth/v4/refresh`, the same call the CLI's
 * `ProtonAuthApi.refresh_session` and the app's `SessionManager.refreshSession`
 * make. No device challenge is involved, so renewal never rotates profiles.
 */

import { apiCall, ApiError, ProxyUnreachableError } from "./api.js"
import { buildChallengePayload, profileRotation } from "./spoof.js"

export class VerificationExhaustedError extends Error {
	constructor(attempts) {
		super("Every device profile was challenged")
		this.name = "VerificationExhaustedError"
		this.attempts = attempts
	}
}

async function createAnonymousSession(profile, signal) {
	const payload = await apiCall("/auth/v4/sessions", {
		method: "POST",
		profile,
		body: buildChallengePayload(profile),
		signal,
	})

	return { accessToken: payload.AccessToken, uid: payload.UID, refreshToken: payload.RefreshToken ?? null }
}

async function upgradeToCredentialless(profile, session, signal) {
	const payload = await apiCall("/auth/v4/credentialless", {
		method: "POST",
		profile,
		session,
		body: buildChallengePayload(profile),
		signal,
	})

	return {
		accessToken: payload.AccessToken ?? session.accessToken,
		uid: payload.UID ?? session.uid,
		refreshToken: payload.RefreshToken ?? session.refreshToken,
	}
}

/**
 * Logs in as a guest.
 *
 * @param onProgress called with `{ stage, profile, attempt, total }` so the UI
 *   can show which device profile is being used, including silent retries.
 * @returns {Promise<{accessToken: string, uid: string, refreshToken: string|null, profile: object}>}
 */
export async function loginAsGuest({ onProgress = () => {}, signal } = {}) {
	const profiles = profileRotation()
	const attempts = []

	for (const [index, profile] of profiles.entries()) {
		const progress = { profile, attempt: index + 1, total: profiles.length }

		try {
			onProgress({ ...progress, stage: "session" })
			const anonymous = await createAnonymousSession(profile, signal)

			onProgress({ ...progress, stage: "credentialless" })
			const session = await upgradeToCredentialless(profile, anonymous, signal)

			onProgress({ ...progress, stage: "done" })
			return { ...session, profile }
		} catch (error) {
			if (error instanceof ProxyUnreachableError) throw error
			if (error?.name === "AbortError") throw error

			if (error instanceof ApiError && error.needsVerification) {
				// A captcha for this fingerprint. Swap the device profile and retry
				// without bothering the user.
				attempts.push({ profile: profile.id, code: error.code })
				onProgress({ ...progress, stage: "rotating" })
				continue
			}

			throw error
		}
	}

	throw new VerificationExhaustedError(attempts)
}

/**
 * Trades the refresh token for a fresh token pair.
 *
 * The refresh grant authenticates with the refresh token in the body and the
 * session UID in the header; the access token is not sent, because the whole
 * point is that it may already be rejected. Proton answers with a new access
 * token and usually a new refresh token — when it does not rotate, the old
 * refresh token is kept, exactly as the CLI does.
 *
 * @returns {Promise<{accessToken: string, uid: string, refreshToken: string|null}>}
 */
export async function refreshSession({ profile, session, signal }) {
	if (typeof session?.refreshToken !== "string" || session.refreshToken.length === 0) {
		throw new Error("Cannot renew a session without a refresh token")
	}

	const payload = await apiCall("/auth/v4/refresh", {
		method: "POST",
		profile,
		session: { uid: session.uid },
		body: {
			ResponseType: "token",
			GrantType: "refresh_token",
			RefreshToken: session.refreshToken,
			RedirectURI: "https://protonvpn.com",
		},
		signal,
	})

	return {
		accessToken: payload.AccessToken ?? session.accessToken,
		uid: payload.UID ?? session.uid,
		refreshToken: payload.RefreshToken ?? session.refreshToken,
	}
}
