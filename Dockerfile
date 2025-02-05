ARG NODE=20.11.1

FROM node:$NODE AS builder

# convenience
SHELL ["/bin/bash", "-c"]

ARG SPT_REF=3.10.5
ARG SPT_BRANCH=master

WORKDIR /server

# make sure we can run in non-interactive mode
RUN echo 'debconf debconf/frontend select Noninteractive' | debconf-set-selections

# install build deps
RUN apt update && apt install -yq git git-lfs curl

# clone spt server & checkout
RUN \
  git clone --branch=$SPT_BRANCH https://dev.sp-tarkov.com/SPT/Server.git spt-source && cd $_/project && \ 
  git checkout $SPT_REF && \
  git-lfs pull && \
  sed -i '/SetEncoding/d' src/Program.ts || true

# deps, build, move to our volume, and clean up
RUN \
  cd spt-source/project && \
  npm install && \
  npm run build:release -- --arch=$([ "$(uname -m)" = "aarch64" ] && echo arm64 || echo x64) --platform=linux && \
  mv build/* /server/ && \
  sed -i 's/127.0.0.1/0.0.0.0/g' /server/SPT_Data/Server/configs/http.json && \
  rm -rf /server/spt-source/

# grab modsync updater executable
RUN \
  wget https://github.com/c-orter/ModSync/releases/download/v0.10.2/Corter-ModSync-v0.10.2.zip -O modsync.zip && \
  unzip modsync.zip -d /server/_modsync && \
  mv /server/_modsync/ModSync.Updater.exe /server/ && \
  rm modsync.zip && \
  rm -rf /server/_modsync

# final image
FROM ubuntu:latest

WORKDIR /server

COPY --from=builder /server .
COPY start.sh .

EXPOSE 6969

CMD ./start.sh