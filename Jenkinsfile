pipeline {
  agent none

  options {
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  stages {
    stage('Detect Changes') {
      agent {
        kubernetes {
          defaultContainer 'git'
          yaml '''
apiVersion: v1
kind: Pod
spec:
  securityContext:
    runAsUser: 1000
    runAsGroup: 1000
  containers:
    - name: git
      image: node:22-bookworm
      command:
        - cat
      tty: true
'''
        }
      }

      steps {
        checkout scm

        script {
          def readChangedFiles = { String mode, String baseRef ->
            writeFile file: '.ci-diff-mode', text: mode
            writeFile file: '.ci-diff-base', text: baseRef ?: ''

            sh '''#!/usr/bin/env bash
set -euo pipefail

mode="$(cat .ci-diff-mode)"
base_ref="$(cat .ci-diff-base)"

case "$mode" in
  pr)
    git fetch --no-tags origin "+refs/heads/${base_ref}:refs/remotes/origin/${base_ref}"
    git diff --name-only "origin/${base_ref}...HEAD" > .ci-changed-files
    printf 'true\n' > .ci-diff-base-found
    ;;
  branch)
    if [ -n "$base_ref" ] && git cat-file -e "${base_ref}^{commit}" 2>/dev/null; then
      git diff --name-only "${base_ref}..HEAD" > .ci-changed-files
      printf 'true\n' > .ci-diff-base-found
    else
      : > .ci-changed-files
      printf 'false\n' > .ci-diff-base-found
    fi
    ;;
  *)
    echo "Unsupported change detection mode: $mode" >&2
    exit 1
    ;;
esac
            '''

            return readFile('.ci-changed-files')
              .split('\\n')
              .collect { it.trim() }
              .findAll { it }
          }

          def matchesAny = { List<String> files, List<String> patterns ->
            files.any { file ->
              patterns.any { pattern ->
                if (pattern.endsWith('/**')) {
                  return file.startsWith(pattern.substring(0, pattern.length() - 2))
                }

                return file == pattern
              }
            }
          }

          def isPr = env.CHANGE_ID?.trim()
          def checkFiles = []
          def releaseFiles = []

          if (isPr) {
            checkFiles = readChangedFiles('pr', env.CHANGE_TARGET)

            env.RUN_PWA_CHECK = matchesAny(checkFiles, ['Jenkinsfile', 'ci/Jenkinsfile.pwa-build', 'pwa/**']).toString()
            env.RUN_BACKEND_CHECK = matchesAny(checkFiles, ['Jenkinsfile', 'backend/**']).toString()

            env.RUN_PWA_BUILD = 'false'
            env.RUN_BACKEND_BUILD = 'false'

            echo "Change detection mode: PR against origin/${env.CHANGE_TARGET}"
          } else {
            env.RUN_PWA_CHECK = 'true'
            env.RUN_BACKEND_CHECK = 'true'

            if (env.BRANCH_NAME == 'main') {
              def baseCommit = env.GIT_PREVIOUS_SUCCESSFUL_COMMIT?.trim() ?: env.GIT_PREVIOUS_COMMIT?.trim()
              releaseFiles = readChangedFiles('branch', baseCommit ?: '')
              def hasBaseCommit = readFile('.ci-diff-base-found').trim() == 'true'

              env.RUN_PWA_BUILD = (!hasBaseCommit || matchesAny(releaseFiles, ['Jenkinsfile', 'ci/Jenkinsfile.pwa-build', 'pwa/**'])).toString()
              env.RUN_BACKEND_BUILD = matchesAny(releaseFiles, ['Jenkinsfile', 'ci/Jenkinsfile.backend-build', 'backend/**']).toString()

              echo "Change detection mode: main branch from ${baseCommit ?: 'no previous commit'}"
            } else {
              env.RUN_PWA_BUILD = 'false'
              env.RUN_BACKEND_BUILD = 'false'

              echo "Change detection mode: branch ${env.BRANCH_NAME}"
            }
          }

          echo "Check changed files:\n${checkFiles.join('\n') ?: '(none)'}"
          if (env.BRANCH_NAME == 'main' && !isPr) {
            echo "Release changed files:\n${releaseFiles.join('\n') ?: '(none)'}"
          }

          echo """Change flags:
RUN_PWA_CHECK=${env.RUN_PWA_CHECK}
RUN_BACKEND_CHECK=${env.RUN_BACKEND_CHECK}
RUN_PWA_BUILD=${env.RUN_PWA_BUILD}
RUN_BACKEND_BUILD=${env.RUN_BACKEND_BUILD}"""
        }
      }
    }

    stage('checks') {
      parallel {
        stage('PWA') {
          when {
            expression { env.RUN_PWA_CHECK == 'true' }
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
      image: node:22.22.3-bookworm
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

                dir('pwa') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

npm ci
                  '''
                }
              }
            }

            stage('Build') {
              steps {
                dir('pwa') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

npm run build
                  '''
                }
              }
            }

            stage('Build Production') {
              steps {
                dir('pwa') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

npm run build:prod
                  '''
                }
              }
            }

            stage('Test') {
              steps {
                dir('pwa') {
                  sh '''#!/usr/bin/env bash
set -euo pipefail

npm run test:ci
npm run test:pwa
                  '''
                }
                script {
                  env.PWA_CHECKS_PASSED = 'true'
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
                testResults: 'pwa/test_output/*.xml'

              script {
                if (env.PWA_CHECKS_PASSED == 'true') {
                  publishChecks name: 'checks / PWA',
                    title: 'PWA',
                    summary: 'PWA checks passed',
                    status: 'COMPLETED',
                    conclusion: 'SUCCESS'
                }
              }
            }
          }
        }

        stage('Backend') {
          when {
            expression { env.RUN_BACKEND_CHECK == 'true' }
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

    stage('Trigger PWA Artifact Build') {
      when {
        expression { env.RUN_PWA_BUILD == 'true' }
      }

      steps {
        build job: 'chahua/chahua-pwa-build',
          wait: false,
          parameters: [
            string(name: 'GIT_COMMIT_SHA', value: env.GIT_COMMIT)
          ]
      }
    }

    stage('Trigger Backend Image Build') {
      when {
        expression { env.RUN_BACKEND_BUILD == 'true' }
      }

      steps {
        build job: 'chahua/chahua-backend-build',
          wait: false,
          parameters: [
            string(name: 'GIT_COMMIT_SHA', value: env.GIT_COMMIT)
          ]
      }
    }
  }
}
