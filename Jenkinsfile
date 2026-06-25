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
      }
    }
  }

  post {
    success {
      publishChecks name: 'required-checks',
        title: 'Required Checks',
        summary: 'All applicable checks passed',
        status: 'COMPLETED',
        conclusion: 'SUCCESS'
    }

    failure {
      publishChecks name: 'required-checks',
        title: 'Required Checks',
        summary: 'One or more applicable checks failed',
        status: 'COMPLETED',
        conclusion: 'FAILURE'
    }

    aborted {
      publishChecks name: 'required-checks',
        title: 'Required Checks',
        summary: 'Build was aborted',
        status: 'COMPLETED',
        conclusion: 'CANCELED'
    }
  }
}
