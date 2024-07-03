#!/bin/sh

if [[ -z "$SSH_PUB_KEY_FILE" ]]; then
  SSH_PUB_KEY=""
else
  SSH_PUB_KEY=$(cat $SSH_PUB_KEY_FILE)
fi

yarn cdk deploy \
  --context "sftpPublicKey=$SSH_PUB_KEY"