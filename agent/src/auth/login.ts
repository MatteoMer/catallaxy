#!/usr/bin/env tsx
/**
 * CLI script: run `npm run login` to authenticate with Claude Max via OAuth.
 * Saves tokens to ~/.catallaxy/tokens.json
 */

import { login } from "./oauth.js";
import { saveCredentials } from "./token-store.js";

const credentials = await login();
await saveCredentials(credentials);
console.log("Tokens saved to ~/.catallaxy/tokens.json");
