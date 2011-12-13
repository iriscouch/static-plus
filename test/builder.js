var tap = require('tap')
  , test = tap.test

var api = require('../api')

test('Builder API', function(t) {
  t.doesNotThrow(function() { return new api.Builder }, 'Create a new builder')

  t.end()
})
