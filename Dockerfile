# ProofPay web app + verifier agent. Contracts are deployed separately (see scripts/deploy-aevum.sh).
FROM node:24-slim
WORKDIR /app
COPY app/package.json app/package-lock.json ./app/
RUN cd app && npm ci --omit=dev
COPY app ./app
COPY deployments ./deployments
WORKDIR /app/app
ENV PORT=8787 DATA_DIR=/data
VOLUME /data
EXPOSE 8787
# Pass AGENT_PRIVATE_KEY / GEMINI_API_KEY (and optional DEMO_*) at runtime via --env-file; never bake them in.
CMD ["node", "src/server.ts"]
