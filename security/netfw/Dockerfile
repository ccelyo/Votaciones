# Firewall de entrada por servicio (escenario de seguridad 3, Prototipo 3).
# Se ejecuta como sidecar en el espacio de red del servicio que protege; el
# servicio nunca recibe NET_ADMIN. curl, netcat y nmap los usa el script de
# verificación para sondear desde el espacio de red de otro contenedor.
FROM alpine:3.20
RUN apk add --no-cache iptables ip6tables tcpdump curl netcat-openbsd openssl nmap
COPY acl.sh /acl.sh
RUN chmod +x /acl.sh
ENTRYPOINT ["/acl.sh"]
