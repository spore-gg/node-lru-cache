#!/usr/bin/env bash

cd $(dirname "${BASH_SOURCE[0]}")/..

echo "compiling dist/"

npm install

TSC_PATH=$(npm bin)/tsc

$TSC_PATH --project .
