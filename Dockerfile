ARG NODE=20.11.1

FROM node:$NODE AS builder

# convenience
SHELL ["/bin/bash", "-c"]

ARG SPT_REF=3.8.3
ARG SPT_BRANCH=master
ARG FIKA_REF=HEAD^
ARG FIKA_BRANCH=main

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
  sed -i 's/127.0.0.1/0.0.0.0/g' /server/Aki_Data/Server/configs/http.json && \
  rm -rf /server/spt-source/

# final image
FROM ubuntu:latest

WORKDIR /server

COPY --from=builder /server .
COPY start.sh .

EXPOSE 6969

CMD ./start.sh