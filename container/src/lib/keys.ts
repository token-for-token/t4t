import {padHex, type Address} from 'viem'
import type {Hex} from './types'

/**
 * v1 placeholder for the provider/client PSS public key registered on-chain.
 * The registry stores it as `bytes32`, but a real secp256k1 compressed pubkey
 * is 33 bytes — so until ECIES lands we right-pad the wallet address to fit.
 *
 * Once ECIES (spec §6) is wired, replace this with a proper PSS keypair stored
 * outside the wallet, and migrate the registry to `bytes` if a longer encoding
 * is needed. Both client and provider must use the same convention so request
 * payloads encrypt against the same key the recipient will decrypt with.
 */
export function pssPubKeyFromWallet(wallet: Address): Hex {
  return padHex(wallet, {size: 32}) as Hex
}
