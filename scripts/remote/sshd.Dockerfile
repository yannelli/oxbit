FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server git procps iproute2 && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd /root/.ssh /root/project && chmod 700 /root/.ssh \
    && ssh-keygen -A && git init /root/project \
    && printf 'export const message = "hello";\n' > /root/project/hello.ts
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e", "-o", "PasswordAuthentication=no", "-o", "UsePAM=no", "-o", "PermitRootLogin=prohibit-password"]
