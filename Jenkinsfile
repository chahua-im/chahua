pipeline {
  agent none

  options {
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  stages {
    stage('checks') {
      parallel {
        stage('PWA') {
          when {
            anyOf {
              changeset 'Jenkinsfile'
              changeset 'wetty-chat-mobile/**'
            }
          }

          agent {
            kubernetes {
              defaultContainer 'node'
              yaml '''
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: node
      image: node:22-bookworm
      command:
        - cat
      tty: true
'''
            }
          }

          stages {
            stage('Install Dependencies') {
              steps {
                publishChecks name: 'checks / PWA',
                  title: 'PWA',
                  summary: 'Running PWA checks',
                  status: 'IN_PROGRESS',
                  conclusion: 'NONE'

                dir('wetty-chat-mobile') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

npm ci
                  '''
                }
              }
            }

            stage('Format') {
              steps {
                dir('wetty-chat-mobile') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

npm run format:ci
                  '''
                }
              }
            }

            stage('Typecheck') {
              steps {
                dir('wetty-chat-mobile') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

npm run typecheck
                  '''
                }
              }
            }

            stage('Lint') {
              steps {
                dir('wetty-chat-mobile') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

npm run lint
                  '''
                }
              }
            }

            stage('Lingui') {
              steps {
                dir('wetty-chat-mobile') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

npm run lingui:extract
npm run lingui:compile
                  '''
                }
              }
            }

            stage('Test') {
              steps {
                dir('wetty-chat-mobile') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

npm run test:run
                  '''
                }
              }
            }
          }

          post {
            failure {
              publishChecks name: 'checks / PWA',
                title: 'PWA',
                summary: 'PWA checks failed',
                status: 'COMPLETED',
                conclusion: 'FAILURE'
            }

            aborted {
              publishChecks name: 'checks / PWA',
                title: 'PWA',
                summary: 'PWA checks were aborted',
                status: 'COMPLETED',
                conclusion: 'CANCELED'
            }

            always {
              junit allowEmptyResults: true,
                checksName: 'checks / PWA',
                testResults: 'wetty-chat-mobile/test_output/report.xml'
            }
          }
        }

        stage('Backend') {
          when {
            anyOf {
              changeset 'Jenkinsfile'
              changeset 'backend/**'
            }
          }

          agent {
            kubernetes {
              defaultContainer 'rust'
              yaml '''
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: rust
      image: ghcr.io/chahua-im/chahua-backend-builder-base:amd64-rust-1.95.0-trixie
      command:
        - cat
      tty: true
'''
            }
          }

          stages {
            stage('Install Tools') {
              steps {
                publishChecks name: 'checks / Backend',
                  title: 'Backend',
                  summary: 'Running backend checks',
                  status: 'IN_PROGRESS',
                  conclusion: 'NONE'

                dir('backend') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

curl -LsSf https://get.nexte.st/latest/linux | tar zxf - -C /usr/local/cargo/bin
rustup component add rustfmt
rustup component add clippy
                  '''
                }
              }
            }

            stage('Format') {
              steps {
                dir('backend') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

cargo fmt -- --check
                  '''
                }
              }
            }

            stage('Clippy') {
              steps {
                dir('backend') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

cargo clippy --all-targets --all-features -- -D warnings
                  '''
                }
              }
            }

            stage('Test') {
              steps {
                dir('backend') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

cargo nextest run --profile ci
                  '''
                }
              }
            }
          }

          post {
            failure {
              publishChecks name: 'checks / Backend',
                title: 'Backend',
                summary: 'Backend checks failed',
                status: 'COMPLETED',
                conclusion: 'FAILURE'
            }

            aborted {
              publishChecks name: 'checks / Backend',
                title: 'Backend',
                summary: 'Backend checks were aborted',
                status: 'COMPLETED',
                conclusion: 'CANCELED'
            }

            always {
              junit allowEmptyResults: true,
                checksName: 'checks / Backend',
                testResults: 'backend/target/**/rust-test-report.xml'
            }
          }
        }

        stage('Flutter') {
          when {
            anyOf {
              changeset 'Jenkinsfile'
              changeset 'wetty-chat-flutter/**'
            }
          }

          agent {
            kubernetes {
              defaultContainer 'flutter'
              yaml '''
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: flutter
      image: ghcr.io/cirruslabs/flutter:stable
      command:
        - cat
      tty: true
'''
            }
          }

          stages {
            stage('Install Tools') {
              steps {
                publishChecks name: 'checks / Flutter',
                  title: 'Flutter',
                  summary: 'Running Flutter checks',
                  status: 'IN_PROGRESS',
                  conclusion: 'NONE'

                dir('wetty-chat-flutter') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

flutter --version
dart --version
dart pub global activate junitreport
                  '''
                }
              }
            }

            stage('Pub Get') {
              steps {
                dir('wetty-chat-flutter') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

flutter pub get
                  '''
                }
              }
            }

            stage('Format') {
              steps {
                dir('wetty-chat-flutter') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

dart format --output=none --set-exit-if-changed .
                  '''
                }
              }
            }

            stage('Analyze') {
              steps {
                dir('wetty-chat-flutter') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

flutter analyze
                  '''
                }
              }
            }

            stage('Test') {
              steps {
                dir('wetty-chat-flutter') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

set +e
flutter test --machine > test_results.jsonl
test_status=$?
set -e

dart pub global run junitreport:tojunit \
  --input test_results.jsonl \
  --output flutter-test-report.xml

exit "$test_status"
                  '''
                }
              }
            }
          }

          post {
            failure {
              publishChecks name: 'checks / Flutter',
                title: 'Flutter',
                summary: 'Flutter checks failed',
                status: 'COMPLETED',
                conclusion: 'FAILURE'
            }

            aborted {
              publishChecks name: 'checks / Flutter',
                title: 'Flutter',
                summary: 'Flutter checks were aborted',
                status: 'COMPLETED',
                conclusion: 'CANCELED'
            }

            always {
              junit allowEmptyResults: true,
                checksName: 'checks / Flutter',
                testResults: 'wetty-chat-flutter/flutter-test-report.xml'
            }
          }
        }
      }
    }

    stage('Build PWA Artifacts') {
      when {
        allOf {
          anyOf {
            branch 'main'
            branch 'woodpecker'
          }
          anyOf {
            changeset 'Jenkinsfile'
            changeset 'wetty-chat-mobile/**'
          }
        }
      }

      agent {
        kubernetes {
          defaultContainer 'node'
          yaml '''
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: node
      image: node:22-bookworm
      command:
        - cat
      tty: true
'''
        }
      }

      stages {
        stage('Install Dependencies') {
          steps {
            dir('wetty-chat-mobile') {
              sh '''#!/usr/bin/env bash
set -euo pipefail

npm ci

if ! command -v zip >/dev/null; then
  apt-get update
  apt-get install -y --no-install-recommends zip
fi
              '''
            }
          }
        }

        stage('Typecheck') {
          steps {
            dir('wetty-chat-mobile') {
              sh '''#!/usr/bin/env bash
set -euo pipefail

npm run typecheck
              '''
            }
          }
        }

        stage('Build') {
          parallel {
            stage('Staging') {
              steps {
                dir('wetty-chat-mobile') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

export CI_BUILD_VERSION="${BUILD_NUMBER}"
npx vite build -c vite.config.staging.ts --mode development
                  '''
                }
              }
            }

            stage('Prod') {
              steps {
                dir('wetty-chat-mobile') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

export CI_BUILD_VERSION="${BUILD_NUMBER}"
npx vite build --base=/ --outDir prod-dist -c vite.config.prod.ts
                  '''
                }
              }
            }
          }
        }

        stage('Archive') {
          steps {
            dir('wetty-chat-mobile') {
              sh '''#!/usr/bin/env bash
set -euo pipefail

rm -f chahua-staging.zip chahua-prod.zip
(cd dist && zip -qr ../chahua-staging.zip .)
(cd prod-dist && zip -qr ../chahua-prod.zip .)
              '''
            }

            archiveArtifacts artifacts: 'wetty-chat-mobile/chahua-staging.zip, wetty-chat-mobile/chahua-prod.zip',
              fingerprint: true,
              onlyIfSuccessful: true
          }
        }
      }
    }
  }
}
