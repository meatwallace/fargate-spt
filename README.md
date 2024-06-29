# AWS + SPT

[SPT](https://sp-tarkov.com/) hosted via [AWS Fargate](https://aws.amazon.com/fargate/), deployed using [CDK](https://aws.amazon.com/cdk/).

I recommend setting things up with [mod-sync](https://github.com/c-orter/modsync).

## Usage

Requires [Docker](https://www.docker.com/) to build the image. You'll probably want [aws-cli](https://aws.amazon.com/cli/) installed to deploy.

Slap all your mods in the `_mods/` structure, and any existing profiles you might want to sync in `_profiles/`. Or don't.
These directories aren't auto deployed at this point in time but I might wire up DataSync with an S3 bucket later. Probably not.

Deploying should look something like:

```sh
# auth AWS
$ aws sso login

# build the cdk stack
$ yarn synth

# deploy the cdk stack
$ SSH_PUB_KEY_FILE="~/.ssh/id_rsa.pub" ./deploy.sh

# sftp into your profiles EFS and copy your existing profiles in
$ sftp -i ~/.ssh/id_rsa spt-profiles-user@<OUTPUT:SPTSFTPServerIP>
sftp> put -r _profiles/* .

# sftp into your mods EFS and upload everything
$ sftp -i ~/.ssh/id_rsa spt-mods-user@<OUTPUT:SPTSFTPServerIP>
sftp> put -r _mods/* .
```

You'll then want to restart your Fargate service. Quickest easiest way is to scale the service to 0 tasks, then scale it back up to 1.
