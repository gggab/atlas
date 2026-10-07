mod credentials;
mod runtime;
mod store;
mod transport;

pub use credentials::{CredentialStore, NativeCredentials};
pub use runtime::{Approval, Identity, Job, RemoteSession, Runtime, Snapshot};
pub use store::{Association, Connection, ConnectionInput, Store};
pub use transport::probe;

pub type Result<T> = std::result::Result<T, String>;

#[cfg(test)]
mod tests;
