use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    #[error("{0}")]
    Unsupported(&'static str),
}

impl Error {
    fn code(&self) -> &'static str {
        match self {
            Error::Io(_) => "IO",
            #[cfg(mobile)]
            Error::PluginInvoke(_) => "NATIVE",
            Error::Unsupported(_) => "UNSUPPORTED",
        }
    }
}

/// Serializes as `{ code, message }`, the shape `@oxbit/host-ios` turns into an `RpcError`.
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("Error", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}
