var tap = require('tap')
  , test = tap.test

var api = require('../api')

test('Builder API', function(t) {
  var builder;

  t.doesNotThrow(function() { builder = new api.Builder }, 'Create a new builder')
  t.ok(builder, 'Got the builder object')

  var did = {}
  builder.on('template', function(template) { did.template = template })
  builder.on('output'  , function(output)   { did.output   = output   })
  builder.on('couch'   , function(couch)    { did.couch    = couch    })

  builder.template = null
  t.throws(function() { builder.start() }, 'Throw for missing template')
  t.notOk(did.template, 'Template not fired when missing')

  builder.template = 1;
  t.throws(function() { builder.start() }, 'Throw for bad template type')
  t.notOk(did.template, 'Template not fired when bad type')

  t.end()
})
