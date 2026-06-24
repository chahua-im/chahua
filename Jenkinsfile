pipeline {
  agent none

  options {
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  stages {
    stage('PWA Check') {
      when {
        beforeAgent true
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
            dir('wetty-chat-mobile') {
              sh '''#!/usr/bin/env bash
set -euo pipefail

npm ci
              '''
            }
          }
        }

        stage('Run PWA Checks') {
          parallel {
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
        }
      }

      post {
        always {
          junit allowEmptyResults: true, testResults: 'wetty-chat-mobile/test_output/report.xml'
        }
      }
    }

    stage('Required Checks') {
      agent none

      steps {
        echo 'All applicable checks passed'
      }
    }
  }

  post {
    success {
      publishChecks name: 'wetty-chat / required-checks',
        title: 'Required Checks',
        summary: 'All applicable checks passed',
        status: 'COMPLETED',
        conclusion: 'SUCCESS'
    }

    failure {
      publishChecks name: 'wetty-chat / required-checks',
        title: 'Required Checks',
        summary: 'One or more applicable checks failed',
        status: 'COMPLETED',
        conclusion: 'FAILURE'
    }

    aborted {
      publishChecks name: 'wetty-chat / required-checks',
        title: 'Required Checks',
        summary: 'Build was aborted',
        status: 'COMPLETED',
        conclusion: 'CANCELED'
    }
  }
}
