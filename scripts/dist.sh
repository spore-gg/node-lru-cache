#!/usr/bin/env bash

cd $(dirname "${BASH_SOURCE[0]}")/..

echo "compiling dist/"

npm install

TSC_PATH=$(npm bin)/tsc

echo "$TSC_PATH"
$TSC_PATH --project .
