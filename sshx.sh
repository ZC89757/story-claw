#!/bin/bash
SSH_ASKPASS="/c/Users/ZhangChi/Desktop/改写漫剧/story-claw/.askpass.sh" SSH_ASKPASS_REQUIRE=force ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p 23 root@117.50.172.196 "$@" < /dev/null
