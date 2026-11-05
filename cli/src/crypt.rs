//! End-to-end encryption (`age` mode, FORMAT.md version 2).
//!
//! One X25519 identity per encrypted folder, stored in the repository as
//! `<folder>/.nubes/key.age`, itself encrypted with the passphrase (scrypt).
//! The passphrase is asked once per device; what the device keeps is the
//! identity (Keychain, or a 0600 file), so scrypt runs once.

use std::io::IsTerminal;
use std::str::FromStr;

use age::secrecy::{ExposeSecret, SecretString};
use anyhow::{anyhow, bail, Context, Result};

/// The scrypt work factor of `key.age` (age's default for passphrases).
const WORK_FACTOR: u8 = 18;

/// What encrypts and decrypts a folder's files.
pub struct Cipher {
    identity: age::x25519::Identity,
    recipient: age::x25519::Recipient,
}

impl Cipher {
    pub fn generate() -> Self {
        Self::from_identity(age::x25519::Identity::generate())
    }

    fn from_identity(identity: age::x25519::Identity) -> Self {
        let recipient = identity.to_public();
        Self {
            identity,
            recipient,
        }
    }

    /// From the `AGE-SECRET-KEY-1…` line a device keeps.
    pub fn parse(secret: &str) -> Result<Self> {
        let id = age::x25519::Identity::from_str(secret.trim())
            .map_err(|e| anyhow!("invalid stored key: {e}"))?;
        Ok(Self::from_identity(id))
    }

    pub fn secret(&self) -> String {
        self.identity.to_string().expose_secret().to_string()
    }

    pub fn recipient(&self) -> String {
        self.recipient.to_string()
    }

    pub fn encrypt(&self, plain: &[u8]) -> Result<Vec<u8>> {
        age::encrypt(&self.recipient, plain).context("encrypting")
    }

    pub fn decrypt(&self, data: &[u8]) -> Result<Vec<u8>> {
        age::decrypt(&self.identity, data)
            .context("decrypting (was this file encrypted for this folder's key?)")
    }

    /// `key.age`: the identity, encrypted with the passphrase.
    pub fn lock(&self, passphrase: &str) -> Result<Vec<u8>> {
        let mut r = age::scrypt::Recipient::new(SecretString::from(passphrase.to_string()));
        r.set_work_factor(WORK_FACTOR);
        age::encrypt(&r, format!("{}\n", self.secret()).as_bytes()).context("encrypting the key")
    }

    /// Opens `key.age` with the passphrase.
    pub fn unlock(key_file: &[u8], passphrase: &str) -> Result<Self> {
        let id = age::scrypt::Identity::new(SecretString::from(passphrase.to_string()));
        let plain = age::decrypt(&id, key_file).map_err(|_| anyhow!("wrong passphrase"))?;
        Self::parse(&String::from_utf8_lossy(&plain))
    }
}

/// The passphrase from `NUBES_PASSPHRASE`, or asked on the terminal (twice when `confirm`).
pub fn passphrase(prompt: &str, confirm: bool) -> Result<String> {
    if let Ok(p) = std::env::var("NUBES_PASSPHRASE") {
        if !p.is_empty() {
            return Ok(p);
        }
    }
    if !std::io::stdin().is_terminal() {
        bail!(
            "this folder is encrypted: run `nubes unlock` in a terminal, or set NUBES_PASSPHRASE"
        );
    }
    let p = rpassword::prompt_password(prompt)?;
    if p.is_empty() {
        bail!("no passphrase given");
    }
    if confirm {
        if p.chars().count() < 10 {
            bail!("use at least 10 characters (several random words are best)");
        }
        if rpassword::prompt_password("Again: ")? != p {
            bail!("the two passphrases differ");
        }
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_key_file() {
        let c = Cipher::generate();
        let data = b"hello, encrypted world";
        let enc = c.encrypt(data).unwrap();
        assert_ne!(&enc[..], data);
        // Each encryption is different (random file key), both decrypt.
        assert_ne!(enc, c.encrypt(data).unwrap());
        assert_eq!(c.decrypt(&enc).unwrap(), data);

        let key = c.lock("correct horse battery").unwrap();
        let back = Cipher::unlock(&key, "correct horse battery").unwrap();
        assert_eq!(back.secret(), c.secret());
        assert_eq!(back.decrypt(&enc).unwrap(), data);
        assert!(Cipher::unlock(&key, "wrong").is_err());
        assert!(Cipher::generate().decrypt(&enc).is_err());
    }

    #[test]
    fn sealed_size_stays_within_the_bound() {
        let c = Cipher::generate();
        for n in [0usize, 1, 65535, 65536, 65537, 3 * 65536 + 5] {
            let sealed = c.encrypt(&vec![7u8; n]).unwrap();
            let max = nubes_core::sealed_size_max(n as u64);
            assert!(
                sealed.len() as u64 <= max,
                "{n} bytes sealed to {}",
                sealed.len()
            );
        }
    }
}
