# Mux URL Signing - SDK Implementation Notes

> Synthesized from Mux signed playback tutorial for SDK implementation auditing.

## Overview

When a Mux asset has a `signed` playback policy, all URLs (video streams, thumbnails, storyboards, etc.) require a valid JWT token to access. The SDK must handle token generation and URL signing internally when the user provides signing credentials.

---

## Signing Key Credentials

Users obtain these from Mux Dashboard → Settings → Signing Keys:

| Credential | Description |
|------------|-------------|
| **Signing Key ID** | The `kid` claim value |
| **Private Key** | Base64-encoded RSA private key |

The SDK should accept these as configuration options (e.g., `muxSigningKey` and `muxPrivateKey`), with fallbacks to `MUX_SIGNING_KEY` and `MUX_PRIVATE_KEY` environment variables.

---

## Token Generation Requirements

### Algorithm

> ⚠️ **Must use RS256 algorithm, NOT the default HS256.**

Most JWT libraries default to HS256. Explicitly specify RS256:

```javascript
jwt.sign(payload, privateKey, { algorithm: 'RS256' })
```

### Base64 Decoding the Private Key

The private key from Mux is **base64-encoded**. Decode before signing:

```javascript
const privateKey = Buffer.from(signingKeySecret, 'base64').toString('utf-8')
```

After decoding, the key should be in PEM format:
```
-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----
```

### Required JWT Claims

| Claim | Description | Value |
|-------|-------------|-------|
| `sub` | The playback ID being signed | String - the Mux playback ID |
| `aud` | Audience - the asset type | Single character: `v`, `t`, `g`, or `s` |
| `exp` | Expiration (Unix timestamp in **seconds**) | Number |
| `kid` | Signing key ID | String - from user credentials |

### Expiration Format

> ⚠️ **Expiration must be Unix timestamp in seconds, not milliseconds.**

```javascript
// Correct - seconds
const exp = Math.floor(Date.now() / 1000) + (60 * 60) // 1 hour from now

// Wrong - milliseconds (will fail)
const exp = Date.now() + (60 * 60 * 1000)
```

---

## Audience Values by Asset Type

> ⚠️ **Each asset type requires its own token with a distinct `aud` value.**

A video token cannot be used to access thumbnails. The SDK must generate the correct token type for each URL being signed.

| Asset Type | `aud` Value | URL Pattern |
|------------|-------------|-------------|
| Video/Playback | `v` | `stream.mux.com/{playbackId}.m3u8` |
| Thumbnail | `t` | `image.mux.com/{playbackId}/thumbnail.jpg` |
| GIF | `g` | `image.mux.com/{playbackId}/animated.gif` |
| Storyboard | `s` | `image.mux.com/{playbackId}/storyboard.vtt` |

---

## Signed URL Construction

Once the token is generated, append it as a query parameter:

```
https://image.mux.com/{playbackId}/thumbnail.jpg?token={signedToken}
```

For URLs that already have query parameters, append with `&`:

```
https://image.mux.com/{playbackId}/thumbnail.jpg?width=640&token={signedToken}
```

---

## SDK Implementation Checklist

The signing utility should:

- [ ] Accept signing credentials (`signingKeyId`, `signingKeySecret`)
- [ ] Base64-decode the private key
- [ ] Generate tokens with RS256 algorithm
- [ ] Include all required claims: `sub`, `aud`, `exp`, `kid`
- [ ] Use correct `aud` value based on asset type being accessed
- [ ] Use expiration in seconds (not milliseconds)
- [ ] Append token as query parameter to URLs
- [ ] Handle URLs that already have existing query parameters

---

## Debugging Reference

Common issues when signed URLs fail:

| Symptom | Likely Cause |
|---------|--------------|
| Invalid signature | Wrong algorithm (HS256 vs RS256) or key not decoded from base64 |
| Token expired | Expiration in milliseconds instead of seconds |
| Access denied | Wrong `aud` value for the asset type |
| Invalid token | `sub` doesn't match the playback ID in URL |
| Key not found | `kid` doesn't match a valid signing key, or wrong Mux environment |

---

## Summary

| Requirement | Implementation |
|-------------|----------------|
| Algorithm | RS256 (explicit, not default) |
| Private key format | Base64-decode to PEM |
| Expiration unit | Seconds (not milliseconds) |
| Token attachment | `?token=` or `&token=` query param |
| Separate tokens per asset type | Yes - different `aud` for video/thumbnail/gif/storyboard |
