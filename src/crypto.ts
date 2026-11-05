/**
 * End-to-end encryption of a folder (`age` mode, FORMAT.md version 2), as
 * the CLI does it (cli/src/crypt.rs): one X25519 identity per folder, kept
 * in the repository as `.nubes/key.age`, itself encrypted with the
 * passphrase (scrypt). The age library loads only for an encrypted folder.
 */

/** What encrypts and decrypts a folder's files. */
export interface Cipher {
  /** The `AGE-SECRET-KEY-1…` line this device keeps. */
  readonly secret: string;
  encrypt(data: Uint8Array): Promise<Uint8Array>;
  decrypt(data: Uint8Array): Promise<Uint8Array>;
}

/** The scrypt work factor of `key.age` (age's default for passphrases). */
const WORK_FACTOR = 18;

const lib = () => import("age-encryption");

export async function cipherFor(secret: string): Promise<Cipher> {
  const age = await lib();
  const s = secret.trim();
  const recipient = await age.identityToRecipient(s);
  const dec = new age.Decrypter();
  dec.addIdentity(s);
  const enc = new age.Encrypter();
  enc.addRecipient(recipient);
  return {
    secret: s,
    encrypt: (data) => enc.encrypt(data),
    decrypt: async (data) => {
      try {
        return await dec.decrypt(data);
      } catch {
        throw new Error("This file cannot be decrypted with this folder's key.");
      }
    },
  };
}

/** A new identity for a new encrypted folder. */
export async function newCipher(): Promise<{ cipher: Cipher; recipient: string }> {
  const age = await lib();
  const secret = await age.generateX25519Identity();
  return { cipher: await cipherFor(secret), recipient: await age.identityToRecipient(secret) };
}

/** `key.age`: the identity, encrypted with the passphrase. */
export async function lockKey(c: Cipher, passphrase: string): Promise<Uint8Array> {
  const age = await lib();
  const e = new age.Encrypter();
  e.setPassphrase(passphrase);
  e.setScryptWorkFactor(WORK_FACTOR);
  return e.encrypt(`${c.secret}\n`);
}

/** Opens `key.age` with the passphrase. */
export async function unlockKey(keyFile: Uint8Array, passphrase: string): Promise<Cipher> {
  const age = await lib();
  const d = new age.Decrypter();
  d.addPassphrase(passphrase);
  let secret: string;
  try {
    secret = await d.decrypt(keyFile, "text");
  } catch {
    throw new Error("Wrong passphrase.");
  }
  return cipherFor(secret);
}
