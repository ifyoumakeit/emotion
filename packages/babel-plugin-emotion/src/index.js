// @flow weak
import fs from 'fs'
import {
  basename,
  dirname,
  join as pathJoin,
  sep as pathSep,
  relative
} from 'path'
import { touchSync } from 'touch'
import {
  getIdentifierName,
  getName,
  createRawStringFromTemplateLiteral,
  minify
} from './babel-utils'
import { hashString, Stylis } from 'emotion-utils'
import cssProps from './css-prop'
import ASTObject from './ast-object'

export function hashArray(arr) {
  return hashString(arr.join(''))
}

const staticStylis = new Stylis({ keyframe: false })

export function replaceCssWithCallExpression(
  path,
  identifier,
  state,
  t,
  staticCSSSrcCreator = src => src,
  removePath = false,
  staticCSSSelectorCreator = (name, hash) => `.${name}-${hash}`
) {
  try {
    const { hash, src } = createRawStringFromTemplateLiteral(path.node.quasi)
    const name = getName(getIdentifierName(path, t), 'css')

    if (state.extractStatic && !path.node.quasi.expressions.length) {
      const staticCSSRules = staticStylis(
        staticCSSSelectorCreator(name, hash),
        staticCSSSrcCreator(src, name, hash)
      )
      state.insertStaticRules([staticCSSRules])
      if (!removePath) {
        return path.replaceWith(t.stringLiteral(`${name}-${hash}`))
      }
      return path.replaceWith(t.identifier('undefined'))
    }

    if (!removePath) {
      path.addComment('leading', '#__PURE__')
    }
    path.node.quasi = new ASTObject(
      minify(src),
      path.node.quasi.expressions,
      t
    ).toTemplateLiteral()
    path.node.tag = identifier
  } catch (e) {
    if (path) {
      throw path.buildCodeFrameError(e)
    }

    throw e
  }
}

// babel-plugin-styled-components
// https://github.com/styled-components/babel-plugin-styled-components/blob/37a13e9c21c52148ce6e403100df54c0b1561a88/src/visitors/displayNameAndId.js#L49-L93

const findModuleRoot = filename => {
  if (!filename || filename === 'unknown') {
    return null
  }
  let dir = dirname(filename)
  if (fs.existsSync(pathJoin(dir, 'package.json'))) {
    return dir
  } else if (dir !== filename) {
    return findModuleRoot(dir)
  } else {
    return null
  }
}

const FILE_HASH = 'emotion-file-hash'
const COMPONENT_POSITION = 'emotion-component-position'

const getFileHash = state => {
  const { file } = state
  // hash calculation is costly due to fs operations, so we'll cache it per file.
  if (file.get(FILE_HASH)) {
    return file.get(FILE_HASH)
  }
  const filename = file.opts.filename
  // find module root directory
  const moduleRoot = findModuleRoot(filename)
  const filePath =
    moduleRoot && relative(moduleRoot, filename).replace(pathSep, '/')
  let moduleName = ''
  if (moduleRoot) {
    const packageJsonContent = fs.readFileSync(
      pathJoin(moduleRoot, 'package.json')
    )
    if (packageJsonContent) {
      try {
        moduleName = JSON.parse(packageJsonContent.toString()).name
      } catch (e) {}
    }
  }
  const code = file.code

  const fileHash = hashArray([moduleName, filePath, code])
  file.set(FILE_HASH, fileHash)
  return fileHash
}

const getNextId = state => {
  const id = state.file.get(COMPONENT_POSITION) || 0
  state.file.set(COMPONENT_POSITION, id + 1)
  return id
}

const getComponentId = (state, prefix: string = 'css') => {
  // Prefix the identifier with css- because CSS classes cannot start with a number
  // Also in snapshots with jest-glamor-react the hash will be replaced with an index
  return `${prefix}-${getFileHash(state)}${getNextId(state)}`
}

const interleave = (strings, interpolations) =>
  interpolations.reduce(
    (array, interp, i) => array.concat(interp, strings[i + 1]),
    [strings[0]]
  )

export function buildStyledCallExpression(identifier, tag, path, state, t) {
  const identifierName = getIdentifierName(path, t)

  if (state.extractStatic && !path.node.quasi.expressions.length) {
    const { hash, src } = createRawStringFromTemplateLiteral(
      path.node.quasi,
      identifierName,
      'styled' // we don't want these styles to be merged in css``
    )
    const staticClassName = `css-${hash}`
    const staticCSSRules = staticStylis(`.${staticClassName}`, src)

    state.insertStaticRules([staticCSSRules])
    return t.callExpression(
      t.callExpression(identifier, [
        tag,
        t.objectExpression([
          t.objectProperty(
            t.identifier('id'),
            t.stringLiteral(
              getComponentId(state, getName(getIdentifierName(path, t), 'css'))
            )
          ),
          t.objectProperty(t.identifier('e'), t.stringLiteral(staticClassName))
        ])
      ]),
      []
    )
  }

  const { src } = createRawStringFromTemplateLiteral(path.node.quasi)

  path.addComment('leading', '#__PURE__')

  const templateLiteral = new ASTObject(
    minify(src),
    path.node.quasi.expressions,
    t
  ).toTemplateLiteral()

  const values = interleave(
    templateLiteral.quasis.map(node => t.stringLiteral(node.value.cooked)),
    path.node.quasi.expressions
  ).filter(node => node.value !== '')

  return t.callExpression(
    t.callExpression(identifier, [
      tag,
      t.objectExpression([
        t.objectProperty(
          t.identifier('id'),
          t.stringLiteral(
            getComponentId(state, getName(getIdentifierName(path, t), 'css'))
          )
        )
      ])
    ]),
    values
  )
}

export function buildStyledObjectCallExpression(path, state, identifier, t) {
  const tag = t.isCallExpression(path.node.callee)
    ? path.node.callee.arguments[0]
    : t.stringLiteral(path.node.callee.property.name)
  return t.callExpression(
    t.callExpression(identifier, [
      tag,
      t.objectExpression([
        t.objectProperty(
          t.identifier('id'),
          t.stringLiteral(
            getComponentId(state, getName(getIdentifierName(path, t), 'css'))
          )
        )
      ])
    ]),
    path.node.arguments
  )
}

const visited = Symbol('visited')

const defaultImportedNames = {
  styled: 'styled',
  css: 'css',
  keyframes: 'keyframes',
  injectGlobal: 'injectGlobal',
  fontFace: 'fontFace',
  merge: 'merge'
}

export default function(babel) {
  const { types: t } = babel

  return {
    name: 'emotion', // not required
    inherits: require('babel-plugin-syntax-jsx'),
    visitor: {
      Program: {
        enter(path, state) {
          state.importedNames = {
            ...defaultImportedNames,
            ...state.opts.importedNames
          }
          state.file.metadata.modules.imports.forEach(
            ({ source, imported, specifiers }) => {
              if (source.indexOf('emotion') !== -1) {
                const importedNames = specifiers
                  .filter(
                    v =>
                      [
                        'default',
                        'css',
                        'keyframes',
                        'injectGlobal',
                        'fontFace',
                        'merge'
                      ].indexOf(v.imported) !== -1
                  )
                  .reduce(
                    (acc, { imported, local }) => ({
                      ...acc,
                      [imported === 'default' ? 'styled' : imported]: local
                    }),
                    defaultImportedNames
                  )
                state.importedNames = {
                  ...importedNames,
                  ...state.opts.importedNames
                }
              }
            }
          )

          state.extractStatic =
            // path.hub.file.opts.filename !== 'unknown' ||
            state.opts.extractStatic

          state.staticRules = []

          state.insertStaticRules = function(staticRules) {
            state.staticRules.push(...staticRules)
          }
        },
        exit(path, state) {
          if (state.staticRules.length !== 0) {
            const toWrite = state.staticRules.join('\n').trim()
            const filenameArr = path.hub.file.opts.filename.split('.')
            filenameArr.pop()
            filenameArr.push('emotion', 'css')
            const cssFilename = filenameArr.join('.')
            const exists = fs.existsSync(cssFilename)
            path.node.body.unshift(
              t.importDeclaration(
                [],
                t.stringLiteral('./' + basename(cssFilename))
              )
            )
            if (
              exists ? fs.readFileSync(cssFilename, 'utf8') !== toWrite : true
            ) {
              if (!exists) {
                touchSync(cssFilename)
              }
              fs.writeFileSync(cssFilename, toWrite)
            }
          }
        }
      },
      JSXOpeningElement(path, state) {
        cssProps(path, state, t)
      },
      CallExpression(path, state) {
        if (path[visited]) {
          return
        }
        try {
          if (
            (t.isCallExpression(path.node.callee) &&
              path.node.callee.callee.name === state.importedNames.styled) ||
            (t.isMemberExpression(path.node.callee) &&
              t.isIdentifier(path.node.callee.object) &&
              path.node.callee.object.name === state.importedNames.styled)
          ) {
            const identifier = t.isCallExpression(path.node.callee)
              ? path.node.callee.callee
              : path.node.callee.object
            path.replaceWith(
              buildStyledObjectCallExpression(path, state, identifier, t)
            )
          }
        } catch (e) {
          throw path.buildCodeFrameError(e)
        }

        path[visited] = true
      },
      TaggedTemplateExpression(path, state) {
        if (path[visited]) {
          return
        }
        path[visited] = true
        if (
          // styled.h1`color:${color};`
          t.isMemberExpression(path.node.tag) &&
          path.node.tag.object.name === state.importedNames.styled
        ) {
          path.replaceWith(
            buildStyledCallExpression(
              path.node.tag.object,
              t.stringLiteral(path.node.tag.property.name),
              path,
              state,
              t
            )
          )
        } else if (
          // styled('h1')`color:${color};`
          t.isCallExpression(path.node.tag) &&
          path.node.tag.callee.name === state.importedNames.styled
        ) {
          path.replaceWith(
            buildStyledCallExpression(
              path.node.tag.callee,
              path.node.tag.arguments[0],
              path,
              state,
              t
            )
          )
        } else if (t.isIdentifier(path.node.tag)) {
          if (
            path.node.tag.name === state.importedNames.css ||
            path.node.tag === state.cssPropIdentifier
          ) {
            replaceCssWithCallExpression(path, path.node.tag, state, t)
          } else if (path.node.tag.name === state.importedNames.keyframes) {
            replaceCssWithCallExpression(
              path,
              path.node.tag,
              state,
              t,
              (src, name, hash) => `@keyframes ${name}-${hash} { ${src} }`,
              false,
              () => ''
            )
          } else if (path.node.tag.name === state.importedNames.fontFace) {
            replaceCssWithCallExpression(
              path,
              path.node.tag,
              state,
              t,
              (src, name, hash) => `@font-face {${src}}`,
              true
            )
          } else if (path.node.tag.name === state.importedNames.injectGlobal) {
            replaceCssWithCallExpression(
              path,
              path.node.tag,
              state,
              t,
              undefined,
              true,
              () => ''
            )
          }
        }
      }
    }
  }
}
