use base64::{engine::general_purpose::STANDARD, Engine};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::net::{TcpListener, TcpStream};

pub fn identity() -> Result<(String, rustls::ServerConfig), String> {
    let identity =
        rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).map_err(|e| e.to_string())?;
    let certificate = identity.cert.der().clone();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        identity.signing_key.serialize_der(),
    ));
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| e.to_string())?
    .with_no_client_auth()
    .with_single_cert(vec![certificate.clone()], key)
    .map_err(|e| e.to_string())?;
    Ok((STANDARD.encode(certificate), config))
}

pub fn transport(endpoint: &super::protocol::Endpoint) -> Result<reqwest::Client, String> {
    let certificate = STANDARD
        .decode(&endpoint.certificate)
        .map_err(|_| "Invalid background TLS identity".to_string())?;
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(CertificateDer::from(certificate))
        .map_err(|e| e.to_string())?;
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| e.to_string())?
    .with_root_certificates(roots)
    .with_no_client_auth();
    reqwest::Client::builder()
        .no_proxy()
        .use_preconfigured_tls(config)
        .connect_timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())
}

pub struct Listener {
    pub socket: TcpListener,
    pub acceptor: tokio_rustls::TlsAcceptor,
}

impl axum::serve::Listener for Listener {
    type Io = tokio_rustls::server::TlsStream<TcpStream>;
    type Addr = SocketAddr;
    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            match self.socket.accept().await {
                Ok((socket, address)) => {
                    if let Ok(Ok(stream)) =
                        tokio::time::timeout(Duration::from_secs(2), self.acceptor.accept(socket))
                            .await
                    {
                        return (stream, address);
                    }
                }
                Err(error) => {
                    tracing::warn!("background socket accept failed: {error}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }
    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.socket.local_addr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn genuine_ip_certificate_and_pinned_transport_can_exchange_json() {
        let (certificate, config) = identity().unwrap();
        let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = socket.local_addr().unwrap().port();
        let listener = Listener {
            socket,
            acceptor: tokio_rustls::TlsAcceptor::from(Arc::new(config)),
        };
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                axum::Router::new().route(
                    "/health",
                    axum::routing::get(|| async { axum::Json(serde_json::json!({"ready":true})) }),
                ),
            )
            .await
            .unwrap();
        });
        let endpoint = super::super::protocol::Endpoint {
            protocol: super::super::protocol::PROTOCOL,
            profile: "fixture".into(),
            version: "fixture".into(),
            build: "fixture".into(),
            boot: "fixture".into(),
            pid: 0,
            port,
            token: "fixture".into(),
            certificate,
        };
        let response = transport(&endpoint)
            .unwrap()
            .get(format!("https://127.0.0.1:{port}/health"))
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.json::<serde_json::Value>().await.unwrap(),
            serde_json::json!({"ready":true})
        );
        server.abort();
    }
    #[tokio::test]
    async fn a_reused_port_cannot_receive_the_old_capability_or_message_body() {
        let (certificate, _) = identity().unwrap();
        let (_, impostor) = identity().unwrap();
        let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = socket.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (socket, _) = socket.accept().await.unwrap();
            tokio_rustls::TlsAcceptor::from(Arc::new(impostor))
                .accept(socket)
                .await
                .is_err()
        });
        let endpoint = super::super::protocol::Endpoint {
            protocol: 1,
            profile: "fixture".into(),
            version: "fixture".into(),
            build: "fixture".into(),
            boot: "fixture".into(),
            pid: 0,
            port,
            token: "fixture capability".into(),
            certificate,
        };
        let result = transport(&endpoint)
            .unwrap()
            .post(format!("https://127.0.0.1:{port}/invoke"))
            .bearer_auth(&endpoint.token)
            .body("private fixture message")
            .send()
            .await;
        assert!(result.is_err());
        assert!(server.await.unwrap());
    }
}
