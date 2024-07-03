# Fargate + SPT

[SPT (Single Player Tarkov)](https://sp-tarkov.com/) hosted via [AWS Fargate](https://aws.amazon.com/fargate/), deployed using [CDK](https://aws.amazon.com/cdk/).

I recommend setting up with [mod-sync](https://github.com/c-orter/modsync).

## Usage

Requires [Docker](https://www.docker.com/) to build the image, and [aws-cli](https://aws.amazon.com/cli/) installed to deploy.

When first deploying the server (or updating your mod configuration), you'll want to set the `SFTP_ENABLED` environment
variable to true to deploy an [AWS Transfer Family](https://aws.amazon.com/transfer-family/) server. This will allow you to push your mods and profiles to the server via SFTP. You'll also need to provide an SSH public key to the
deployment script to allow SFTP access - set the path to this key in the `SSH_PUB_KEY_FILE` environment variable.

**!!! NOTE !!!**  
**Once you've pushed your mods & profiles, I recommend redeploying with `SFTP_ENABLED=false` to minimize your cost. AWS Transfer Family isn't cheap to keep online in the scheme of hosting a single Fargate instance.**

Slap all your mods in the `_mods/` structure, and any existing profiles you might want to sync in `_profiles/`. Or don't.
The important thing is that your mod EFS volume contains a `BepInEx/` and `user/` directory, even if empty. The container's [start script](./start.sh) will copy these directories from the volume and fail if they're not there.

Deploying should look something like:

```sh
# auth AWS
$ aws sso login

# build the cdk stack
$ SFTP_ENABLED=true yarn synth

# deploy the cdk stack
$ SFTP_ENABLED=true SSH_PUB_KEY_FILE="~/.ssh/id_rsa.pub" ./deploy.sh

# sftp into your profiles EFS and copy your existing profiles in
$ sftp -i ~/.ssh/id_rsa spt-profiles-user@<OUTPUT:SPT-SFTP-IP>
sftp> put -r _profiles/* .

# sftp into your mods EFS and upload everything
$ sftp -i ~/.ssh/id_rsa spt-mods-user@<OUTPUT:SPT-SFTP-IP>
sftp> put -r _mods/* .

# redeploy without sftp enabled
$ SFTP_ENABLED=false yarn synth
$ SFTP_ENABLED=false yarn deploy
```

You'll then want to restart your Fargate service. Quickest easiest way is to scale the service to 0 tasks, then scale it back up to 1.

## What's My Server IP?

As we're not setting up a network load balancer with a static IP to save costs, your server will be assigned a new IP every time it's restarted as the Fargate task is entirely ephemeral. You can find your server IP by going into the AWS console, going to ECS, and looking under `Task Details -> Network Mapping`.
