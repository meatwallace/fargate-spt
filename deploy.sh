#!/bin/sh

yarn cdk deploy \
  --context "sftpPublicKey=$(cat $SSH_PUB_KEY_FILE)"